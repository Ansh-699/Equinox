"use client";

/** Reads the non-httpOnly CSRF cookie every mutating app/api/* route requires
 * alongside the session cookie (see app/api/auth/session/route.ts). */
export function readCsrfToken(): string | null {
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("equinox_csrf="));
  return match ? decodeURIComponent(match.split("=")[1]) : null;
}
