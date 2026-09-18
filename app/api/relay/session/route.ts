import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifyPrivyAccessToken } from "@/lib/auth/session";
import { routeSessionDatabase, readPersistentSession } from "@/lib/auth/route-session-store";
import { E2E_TEST_TOKEN, isE2eTestModeServer, verifyE2eTestToken } from "@/lib/auth/e2e-test-mode";

/**
 * Same-origin proxy for the Worker's session-key relayer
 * (workers/src/index.ts POST /v1/relay/session).
 *
 * Two independent per-request authentication checks, neither of which is
 * "a shared bearer secret proves this request":
 *   1. This app's own session cookie + CSRF token (same pattern as every
 *      other mutating app/api/auth/* route) -- proves the request came
 *      from this browser's already-authenticated app session.
 *   2. A FRESH Privy access token, sent and verified on every single
 *      request (not cached, not assumed from step 1) -- proves the
 *      specific wallet asserted in the body is the one Privy currently
 *      authenticates, and it must match both the cookie session's wallet
 *      and the token's own linked wallets. A stale or hijacked app-session
 *      cookie without a currently-valid Privy token is rejected here.
 *
 * The Worker itself is reached with a static server-to-server bearer
 * (STOCKSTREAM_RELAYER_TOKEN, today the same value as its INGESTION_TOKEN
 * -- see .env.example) that authenticates THIS SERVER to the Worker, not
 * the end user; it must never reach the browser, and it is not treated as
 * user authorization anywhere in this route. expectedMarket/expectedNonce/
 * clientRequestId are forwarded for the Worker to enforce once its own
 * per-user validation lands (main-agent workstream item 1) -- this proxy
 * checks their presence/shape now so no frontend change is needed later,
 * but does not itself decode the transaction to verify them: that
 * remains the Worker's job, per session-relayer.ts's existing opcode/
 * fee-payer/signature validation.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const csrf = cookieStore.get("stockstream_csrf")?.value;
  if (!csrf || request.headers.get("x-stockstream-csrf") !== csrf) {
    return NextResponse.json({ error: "authentication_required", detail: "CSRF validation failed" }, { status: 403 });
  }
  const session = await readPersistentSession(routeSessionDatabase(), cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "authentication_required", detail: "No application session" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    privyAccessToken?: unknown;
    ownerWallet?: unknown;
    transactionBase64?: unknown;
    expectedProgramAddress?: unknown;
    expectedMarket?: unknown;
    expectedNonce?: unknown;
    sessionSignerAddress?: unknown;
    clientRequestId?: unknown;
    domain?: unknown;
  } | null;
  if (
    typeof body?.privyAccessToken !== "string" ||
    typeof body.ownerWallet !== "string" ||
    typeof body.transactionBase64 !== "string" ||
    typeof body.expectedProgramAddress !== "string" ||
    typeof body.expectedMarket !== "string" ||
    typeof body.expectedNonce !== "string" ||
    typeof body.sessionSignerAddress !== "string" ||
    typeof body.clientRequestId !== "string"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (body.ownerWallet !== session.walletAddress) {
    return NextResponse.json({ error: "authentication_required", detail: "Wallet does not match the app session" }, { status: 401 });
  }

  let verified: Awaited<ReturnType<typeof verifyPrivyAccessToken>>;
  if (isE2eTestModeServer() && body.privyAccessToken === E2E_TEST_TOKEN) {
    verified = verifyE2eTestToken(body.ownerWallet);
  } else {
    try {
      verified = await verifyPrivyAccessToken(body.privyAccessToken);
    } catch {
      return NextResponse.json({ error: "authentication_required", detail: "Privy access token could not be verified" }, { status: 401 });
    }
  }
  if (verified.user_id !== session.privyUserId || !verified.wallets?.includes(body.ownerWallet)) {
    return NextResponse.json({ error: "authentication_required", detail: "Privy token does not match the requesting wallet" }, { status: 401 });
  }

  const relayerUrl = process.env.STOCKSTREAM_RELAYER_URL;
  const relayerToken = process.env.STOCKSTREAM_RELAYER_TOKEN;
  if (!relayerUrl || !relayerToken) return NextResponse.json({ error: "relayer_unconfigured" }, { status: 503 });

  const upstream = await fetch(`${relayerUrl}/v1/relay/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${relayerToken}` },
    body: JSON.stringify({
      transactionBase64: body.transactionBase64,
      expectedProgramAddress: body.expectedProgramAddress,
      sessionSignerAddress: body.sessionSignerAddress,
      domain: body.domain === "er" ? "er" : "l1",
      // Forwarded ahead of Worker support so no frontend change is needed
      // once main-agent item 1 lands; the Worker ignores unknown fields today.
      ownerWallet: body.ownerWallet,
      expectedMarket: body.expectedMarket,
      expectedNonce: body.expectedNonce,
      clientRequestId: body.clientRequestId,
    }),
  }).catch(() => null);
  if (!upstream) return NextResponse.json({ error: "relayer_unavailable" }, { status: 502 });
  const payload = await upstream.json().catch(() => null);
  return NextResponse.json(payload ?? { error: "relayer_response_invalid" }, { status: upstream.status });
}
