import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/imports-better-auth.ts", import.meta.url),
);

describe("Better Auth import boundary", () => {
  it("flags an import of better-auth from outside its files", async () => {
    // ignore: false lints the fixture even though `pnpm lint` ignores it.
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintFiles([fixture]);

    const messages = result?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.ruleId).toBe("no-restricted-imports");
    expect(messages[0]!.message).toMatch(
      /^'better-auth' import is restricted from being used by a pattern\. Better Auth is confined to /,
    );
  });

  it("allows the same import in the files that own it", async () => {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const code =
      'import { betterAuth } from "better-auth";\nexport const a = betterAuth;\n';
    for (const filePath of [
      "src/identity/auth.ts",
      "src/identity/auth-client.ts",
      "src/server/session.ts",
    ]) {
      const [result] = await eslint.lintText(code, {
        filePath: `${root}/${filePath}`,
      });
      expect(result?.messages, filePath).toEqual([]);
    }
  });

  it("flags it in other files under src/identity", async () => {
    const eslint = new ESLint({ cwd: root, ignore: false });
    const [result] = await eslint.lintText(
      'import { admin } from "better-auth/plugins";\nexport const a = admin;\n',
      { filePath: `${root}/src/identity/viewer.ts` },
    );
    expect(result?.messages.map((m) => m.ruleId)).toEqual([
      "no-restricted-imports",
    ]);
  });
});
