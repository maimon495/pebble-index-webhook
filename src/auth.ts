const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/** Accepts the raw token or "Bearer <token>" — the Pebble app's header value is freeform. */
export function isAuthorized(header: string | null, token: string): boolean {
  if (!header) return false;
  return timingSafeEqual(header, token) || timingSafeEqual(header, `Bearer ${token}`);
}
