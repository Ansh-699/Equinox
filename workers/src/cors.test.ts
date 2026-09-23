import { expect, test } from "vitest";
import { applyCors, preflight } from "./cors";

const env = { CORS_ALLOWED_ORIGINS: "https://stockstream.ansht.workers.dev, http://localhost:3000" };
const request = (method: string, origin?: string) =>
  new Request("https://api.example/v1/markets", { method, headers: origin ? { origin } : {} });

test("echoes an allowed origin on read responses only", () => {
  const allowed = applyCors(request("GET", "https://stockstream.ansht.workers.dev"), env, new Response("{}"));
  expect(allowed.headers.get("access-control-allow-origin")).toBe("https://stockstream.ansht.workers.dev");
  expect(allowed.headers.get("vary")).toContain("Origin");
  expect(applyCors(request("GET", "https://evil.example"), env, new Response("{}")).headers.get("access-control-allow-origin")).toBeNull();
  expect(applyCors(request("POST", "http://localhost:3000"), env, new Response("{}")).headers.get("access-control-allow-origin")).toBeNull();
  expect(applyCors(request("GET"), env, new Response("{}")).headers.get("access-control-allow-origin")).toBeNull();
});

test("answers preflight only for allowed origins and read methods", () => {
  expect(preflight(request("OPTIONS", "http://localhost:3000"), env).status).toBe(204);
  expect(preflight(request("OPTIONS", "http://localhost:3000"), env).headers.get("access-control-allow-methods")).toBe("GET, HEAD");
  expect(preflight(request("OPTIONS", "https://evil.example"), env).status).toBe(403);
});

test("opens POST with auth headers only on the routes that ask for it", () => {
  const post = preflight(request("OPTIONS", "http://localhost:3000"), env, true);
  expect(post.headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST");
  expect(post.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  expect(applyCors(request("POST", "http://localhost:3000"), env, new Response("{}"), true).headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
});
