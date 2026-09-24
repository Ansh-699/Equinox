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
 * The Worker itself is reached with two independent, separately-purposed
 * credentials, no longer conflated into one shared bearer:
 *   - `x-equinox-relayer-service-token` (EQUINOX_RELAYER_TOKEN):
 *     authenticates THIS SERVER to the Worker as a legitimate backend. It
 *     must never reach the browser and proves nothing about which user is
 *     making the request.
 *   - `Authorization: Bearer <privyAccessToken>`: the same real, freshly-
 *     verified Privy access token this route just checked above, forwarded
 *     as-is so the Worker can independently re-verify the user's identity
 *     and confirm the claimed wallet is genuinely one Privy has linked to
 *     it (`relay-auth.ts::verifyPrivyToken`) -- defense in depth, not a
 *     redundant formality, since this route and the Worker are separately
 *     deployed and either could drift.
 *
 * expectedProgramAddress/expectedNonce are no longer forwarded: the Worker
 * hardcodes its own canonical program address and derives the opcode/seat/
 * nonce it actually checks straight from the signed transaction bytes, so
 * trusting either as a client claim would have been meaningless.
 *
 * In e2e test mode, `body.privyAccessToken` may be the `E2E_TEST_TOKEN`
 * sentinel (accepted above via `verifyE2eTestToken`) and is forwarded to
 * the Worker as-is; the Worker has its own matching, equally double-gated
 * bypass (`workers/src/index.ts`'s `e2eTestMode` check: an explicit
 * `E2E_TEST_MODE=1` AND never in production AND the same fixed sentinel
 * token), so a full session-relayed trade can succeed end-to-end under e2e
 * test mode without either side ever touching real Privy credentials.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const csrf = cookieStore.get("equinox_csrf")?.value;
  if (!csrf || request.headers.get("x-equinox-csrf") !== csrf) {
    return NextResponse.json({ error: "authentication_required", detail: "CSRF validation failed" }, { status: 403 });
  }
  const session = await readPersistentSession(routeSessionDatabase(), cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "authentication_required", detail: "No application session" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    privyAccessToken?: unknown;
    ownerWallet?: unknown;
    transactionBase64?: unknown;
    expectedMarket?: unknown;
    sessionSignerAddress?: unknown;
    domain?: unknown;
  } | null;
  if (
    typeof body?.privyAccessToken !== "string" ||
    typeof body.ownerWallet !== "string" ||
    typeof body.transactionBase64 !== "string" ||
    typeof body.expectedMarket !== "string" ||
    typeof body.sessionSignerAddress !== "string"
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

  const relayerUrl = process.env.EQUINOX_RELAYER_URL;
  const relayerServiceToken = process.env.EQUINOX_RELAYER_TOKEN;
  if (!relayerUrl || !relayerServiceToken) return NextResponse.json({ error: "relayer_unconfigured" }, { status: 503 });

  const upstream = await fetch(`${relayerUrl}/v1/relay/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${body.privyAccessToken}`,
      "x-equinox-relayer-service-token": relayerServiceToken,
    },
    body: JSON.stringify({
      transactionBase64: body.transactionBase64,
      sessionSignerAddress: body.sessionSignerAddress,
      domain: body.domain === "er" ? "er" : "l1",
      ownerWallet: body.ownerWallet,
      expectedMarket: body.expectedMarket,
    }),
  }).catch(() => null);
  if (!upstream) return NextResponse.json({ error: "relayer_unavailable" }, { status: 502 });
  const payload = await upstream.json().catch(() => null);
  return NextResponse.json(payload ?? { error: "relayer_response_invalid" }, { status: upstream.status });
}
