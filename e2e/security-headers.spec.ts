import { expect, test } from "@playwright/test";
import { pageHydrated } from "./helpers/accounts";

// M9 Task 9: every page is sent with the security headers, and the
// Content-Security-Policy doesn't stop the page itself from working.

const PAGES = [
  "/",
  "/weekend",
  "/prices",
  "/forum",
  "/sign-in",
  "/sign-up/email",
  "/legal/terms",
  "/no-such-page",
];

/** The CSP's directives, by name. */
function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...values]) => [name!, values]),
  );
}

for (const path of PAGES) {
  test(`${path} is sent with a Content-Security-Policy, X-Content-Type-Options, Referrer-Policy and frame-ancestors 'none'`, async ({
    request,
  }) => {
    const response = await request.get(path);
    const headers = response.headers();
    const csp = directives(headers["content-security-policy"] ?? "");
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-frame-options"]).toBe("DENY");
  });
}

test("a static asset is sent with the headers too", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const script = await page
    .locator('script[src^="/assets/"]')
    .first()
    .getAttribute("src");
  const response = await request.get(script!);
  expect(response.status()).toBe(200);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});

test("each page has a nonce of its own, on every inline script", async ({
  request,
}) => {
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await request.get("/sign-in");
    const csp = directives(response.headers()["content-security-policy"]!);
    const nonce = /^'nonce-(.+)'$/.exec(
      csp.get("script-src")!.find((v) => v.startsWith("'nonce-"))!,
    )![1]!;
    nonces.push(nonce);
    const html = await response.text();
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const [, attrs] of inline) {
      expect(attrs).toContain(`nonce="${nonce}"`);
    }
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

test("the policy lets every page load and hydrate with no violation", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `Content Security Policy: ${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
      );
    });
  });
  for (const path of PAGES) {
    await page.goto(path);
    await pageHydrated(page);
  }
  expect(violations).toEqual([]);
});
