import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/imports-provider.ts", import.meta.url),
);

describe("provider import boundary", () => {
  it("flags an import of @/providers/* from outside src/providers", async () => {
    // ignore: false lints the fixture even though `pnpm lint` ignores it.
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([fixture]);

    expect(result).toBeDefined();
    const messages = result?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe("no-restricted-imports");
    // ESLint prefixes a pattern's message with "'<source>' import is
    // restricted from being used by a pattern."
    expect(messages[0]!.message).toMatch(
      /^'@\/providers\/http\/client' import is restricted from being used by a pattern\. Only adapters know providers exist \(HLD §3\.3 rule 2\)\.$/,
    );
  });
});
