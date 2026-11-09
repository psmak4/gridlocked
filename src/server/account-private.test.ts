import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./account.ts", import.meta.url), "utf8");

/** Each `export const name = createServerFn(...)` with its body. */
function serverFunctions(): { name: string; body: string }[] {
  const parts = source.split(/^export const /m).slice(1);
  return parts
    .filter((part) => /^\w+ = createServerFn\(/.test(part))
    .map((part) => ({ name: part.split(" ")[0]!, body: part }));
}

describe("server functions about the signed-in person", () => {
  it("every GET that reads the viewer answers private, no-store", () => {
    // A POST is never cached; a GET can be, so each one says it is private.
    const readers = serverFunctions().filter(
      (fn) =>
        fn.body.includes('createServerFn({ method: "GET" })') &&
        fn.body.includes("requestViewer()"),
    );
    expect(readers.map((fn) => fn.name)).toContain("getOnboarding");
    for (const fn of readers) {
      expect(
        fn.body.includes("privately()") ||
          fn.body.includes('"private, no-store"'),
        fn.name,
      ).toBe(true);
    }
  });
});
