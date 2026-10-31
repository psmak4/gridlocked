import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/react-violations.tsx", import.meta.url),
);

describe("React and accessibility rules", () => {
  it("flags hooks, keys and accessibility mistakes in components", async () => {
    // ignore: false lints the fixture even though `pnpm lint` ignores it.
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([fixture]);

    expect(result).toBeDefined();
    const ruleIds = [
      ...new Set((result?.messages ?? []).map((m) => m.ruleId)),
    ].sort();
    expect(ruleIds).toEqual([
      "jsx-a11y/alt-text",
      "jsx-a11y/click-events-have-key-events",
      "jsx-a11y/no-static-element-interactions",
      "react-hooks/rules-of-hooks",
      "react/jsx-key",
    ]);
  });
});
