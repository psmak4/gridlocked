/**
 * Error responses are never cached (HLD §11.4). Route `headers()` apply to
 * error responses too: in the framework spike a 500 went out marked
 * `public, s-maxage=60`, which a CDN may store and serve to everyone.
 */
export function noStoreOnError(response: Response): Response {
  if (response.status >= 400) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
