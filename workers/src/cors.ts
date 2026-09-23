/** Read-only CORS for the public market API: the browser app reads market
 * state cross-origin; every write/relay route stays server-to-server. */
type CorsEnv = { CORS_ALLOWED_ORIGINS?: string };

function allowedOrigin(request: Request, env: CorsEnv): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = (env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin: string, allowPost: boolean): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": allowPost ? "GET, HEAD, POST" : "GET, HEAD",
    ...(allowPost ? { "access-control-allow-headers": "authorization, content-type" } : {}),
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function preflight(request: Request, env: CorsEnv, allowPost = false): Response {
  const origin = allowedOrigin(request, env);
  return origin ? new Response(null, { status: 204, headers: corsHeaders(origin, allowPost) }) : new Response(null, { status: 403 });
}

/** `allowPost` opens the specific public POST routes (oracle refresh, faucet). */
export function applyCors(request: Request, env: CorsEnv, response: Response, allowPost = false): Response {
  const origin = allowedOrigin(request, env);
  const readMethod = request.method === "GET" || request.method === "HEAD";
  if (!origin || !(readMethod || (allowPost && request.method === "POST")) || response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin, allowPost))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
