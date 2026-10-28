import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/uses-date-now.ts", import.meta.url),
);

describe("no direct time reads", () => {
  it("flags Date.now() and argument-less new Date() outside the clock", async () => {
    // ignore: false lints the fixture even though `pnpm lint` ignores it.
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([fixture]);

    expect(result).toBeDefined();
    const messages = result?.messages ?? [];
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.ruleId).toBe("no-restricted-syntax");
      expect(message.message).toBe(
        "Use the injectable clock (src/lib/clock.ts).",
      );
    }
  });
});
