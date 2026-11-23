import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/accounts";

// The CDN caches public pages for logged-out readers (M9 Task 6). Vercel's
// CDN won't keep a response that varies on Cookie, so none does; the edge
// puts a request with the session cookie under its own key by adding
// `__signed_in=1` (`signedInRoutes`), which this server never sees locally.
// Here: the headers each reader gets, and the flag doing no harm.

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=30";
const PUBLIC_PAGES = ["/weekend", "/prices", "/prices/how", "/forum"];

test("a request without a session cookie gets public, s-maxage=60, stale-while-revalidate=30 and no Vary: Cookie", async ({
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  for (const path of PUBLIC_PAGES) {
    for (const url of [path, `${path}?__signed_in=1`]) {
      const response = await anonymous.get(url, { maxRedirects: 0 });
      expect(response.status(), url).toBe(200);
      expect(response.headers()["cache-control"], url).toBe(PUBLIC_CACHE);
      expect(response.headers()["vary"] ?? "", url).not.toMatch(/cookie/i);
      expect(response.headers()["set-cookie"], url).toBeUndefined();
    }
  }
  await anonymous.dispose();
});

test("a request with a session cookie is never answered from, or stored in, the shared copy", async ({
  page,
}) => {
  const request = page.context().request;
  await createAccount(request);
  for (const path of PUBLIC_PAGES) {
    const response = await request.get(`${path}?__signed_in=1`);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe("private, no-store");
  }
});

test("the flag never travels in a sign-in page's next", async ({
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL });
  const response = await anonymous.get("/leagues?__signed_in=1", {
    maxRedirects: 0,
  });
  expect(response.status()).toBeGreaterThanOrEqual(300);
  expect(response.status()).toBeLessThan(400);
  const location = new URL(response.headers()["location"]!, baseURL);
  expect(location.pathname).toBe("/sign-in");
  expect(location.searchParams.get("next")).toBe("/leagues");
  await anonymous.dispose();
});
