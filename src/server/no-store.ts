/**
 * Marks a response `private, no-store` (HLD §11.4). A redirect built with
 * `Response.redirect()` has immutable headers, so then the response is copied.
 */
export function withNoStore(response: Response): Response {
  try {
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
