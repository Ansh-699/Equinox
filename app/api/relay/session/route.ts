import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { routeSessionDatabase, readPersistentSession } from "@/lib/auth/route-session-store";

/**
 * Same-origin proxy for the Worker's session-key relayer
 * (workers/src/index.ts POST /v1/relay/session).
 *
 * The Worker route is gated by a static server-to-server bearer token
 * (INGESTION_TOKEN today -- see docs note below). That token must never
 * reach the browser: a leaked copy would let anyone relay ANY user's
 * already-session-signed transaction past rate limiting, and it is the
 * same secret the keeper uses for ingestion. This route holds it
 * server-side, gates the call behind the browser's own authenticated app
 * session (cookie + CSRF, matching every other mutating app/api/auth/*
 * route), and forwards only the session-signed transaction the browser
 * already built and signed with its own session key.
 *
 * Known backend contract gap (do not silently paper over): the Worker
 * route has no per-user auth of its own, only the shared ingestion
 * bearer -- STOCKSTREAM_RELAYER_TOKEN below must currently be set to the
 * exact same value as the Worker's INGESTION_TOKEN. That conflates two
 * different trust domains (keeper ingestion vs. relaying a user's own
 * trade) behind one secret. Splitting them into distinct env vars on the
 * Worker is a proposed shared change for the protocol/backend agent, not
 * something this frontend route can fix unilaterally.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const csrf = cookieStore.get("stockstream_csrf")?.value;
  if (!csrf || request.headers.get("x-stockstream-csrf") !== csrf) {
    return NextResponse.json({ error: "CSRF validation failed" }, { status: 403 });
  }
  const session = await readPersistentSession(routeSessionDatabase(), cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const relayerUrl = process.env.STOCKSTREAM_RELAYER_URL;
  const relayerToken = process.env.STOCKSTREAM_RELAYER_TOKEN;
  if (!relayerUrl || !relayerToken) return NextResponse.json({ error: "relayer_unconfigured" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as {
    transactionBase64?: unknown;
    expectedProgramAddress?: unknown;
    sessionSignerAddress?: unknown;
    domain?: unknown;
  } | null;
  if (
    typeof body?.transactionBase64 !== "string" ||
    typeof body.expectedProgramAddress !== "string" ||
    typeof body.sessionSignerAddress !== "string"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const upstream = await fetch(`${relayerUrl}/v1/relay/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${relayerToken}` },
    body: JSON.stringify({
      transactionBase64: body.transactionBase64,
      expectedProgramAddress: body.expectedProgramAddress,
      sessionSignerAddress: body.sessionSignerAddress,
      domain: body.domain === "er" ? "er" : "l1",
    }),
  });
  const payload = await upstream.json().catch(() => null);
  return NextResponse.json(payload ?? { error: "relayer_response_invalid" }, { status: upstream.status });
}
