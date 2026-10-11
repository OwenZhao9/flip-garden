// CORS: only the public page and local development may read the API from a browser.
export const ALLOWED_ORIGIN = 'https://owenzhao9.github.io';
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export const originAllowed = (origin: string | null): boolean => origin === ALLOWED_ORIGIN || (origin !== null && LOCAL.test(origin));

// Headers for a response. A request without an Origin header (curl, server-side) gets none; a disallowed origin gets none.
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !originAllowed(origin)) return { vary: 'origin' };
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin' };
}
