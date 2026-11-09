import { expect, test, type Request } from "@playwright/test";
import { newUsername, ORIGIN, ownAddress } from "./helpers/accounts";

// Ruling 59: Start's CSRF check on server-function requests, through the
// built server's real handler. A server function's URL is a build hash, so
// one the sign-up form really sends (the username check) is caught and then
// sent again with other headers.

/** The username check the sign-up form posts, as the browser sent it. */
async function capturedCheck(page: import("@playwright/test").Page) {
  await page.goto("/sign-up/email");
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toBeEnabled();
  const [sent] = await Promise.all([
    page.waitForRequest(
      (r: Request) => r.method() === "POST" && r.url().includes("/_serverFn/"),
    ),
    (async () => {
      const username = page.getByLabel("Username");
      await username.fill(newUsername());
      await username.blur();
    })(),
  ]);
  const headers = await sent.allHeaders();
  // Only what the call itself needs; the origin headers are set per case.
  const own = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !/^(origin|referer|sec-fetch-|host$|cookie$|content-length$|:)/i.test(
          name,
        ),
    ),
  );
  return { url: sent.url(), body: sent.postData() ?? "", headers: own };
}

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

test.describe("CSRF on server functions", () => {
  test("the browser's own call passes", async ({ page }) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" && r.url().includes("/_serverFn/"),
      ),
      capturedCheck(page),
    ]);
    expect(response.status()).toBe(200);
  });

  test("a cross-origin call is refused, a same-origin one passes", async ({
    page,
    request,
  }) => {
    const check = await capturedCheck(page);
    const send = (extra: Record<string, string>) =>
      request.post(check.url, {
        headers: { ...check.headers, ...extra },
        data: check.body,
      });

    for (const extra of <Record<string, string>[]>[
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      { referer: "https://evil.example/page" },
      // A request that says nothing about where it came from.
      {},
    ]) {
      const refused = await send(extra);
      expect(refused.status(), JSON.stringify(extra)).toBe(403);
      expect(refused.headers()["cache-control"]).toBe("private, no-store");
    }

    for (const extra of <Record<string, string>[]>[
      { origin: ORIGIN, "sec-fetch-site": "same-origin" },
      { origin: ORIGIN },
    ]) {
      const passed = await send(extra);
      expect(passed.status(), JSON.stringify(extra)).toBe(200);
    }
  });

  test("a page opened from another site still renders, its SSR calls included", async ({
    request,
  }) => {
    // The root route's gate calls a server function while rendering.
    const response = await request.get("/sign-in", {
      headers: {
        "sec-fetch-site": "cross-site",
        referer: "https://evil.example/link",
      },
    });
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Sign in");
  });
});
