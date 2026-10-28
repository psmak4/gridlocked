import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { palette, type ColorToken } from "./tokens";

// Strip comments and normalize whitespace after commas, so Prettier's line
// breaks in selector lists don't matter.
const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/,\s+/g, ", ");

/** Declarations of the first rule block whose selector matches exactly. */
function declarationsOf(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^{}]*)\\}`).exec(
    css,
  );
  if (!match) throw new Error(`No rule found for selector: ${selector}`);
  const declarations = new Map<string, string>();
  for (const decl of (match[1] ?? "").split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    declarations.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  }
  return declarations;
}

const names = Object.keys(palette.light) as ColorToken[];

function expectBlock(
  declarations: Map<string, string>,
  values: Record<ColorToken, string>,
) {
  for (const name of names) {
    expect(declarations.get(`--${name}`), `--${name}`).toBe(values[name]);
  }
}

describe("tokens.css matches tokens.ts", () => {
  it("light values are in the :root / light block", () => {
    expectBlock(declarationsOf(':root, [data-theme="light"]'), palette.light);
  });

  it("dark values are in the [data-theme=dark] block", () => {
    expectBlock(declarationsOf('[data-theme="dark"]'), palette.dark);
  });

  it("dark values are in the prefers-color-scheme block", () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{/);
    expectBlock(
      declarationsOf(':root:not([data-theme="light"])'),
      palette.dark,
    );
  });

  it("defines space, radius and font variables", () => {
    const root = declarationsOf(":root");
    for (const key of [
      "--space-1",
      "--space-2",
      "--space-3",
      "--space-4",
      "--space-5",
      "--space-6",
      "--radius-s",
      "--radius-m",
      "--radius-l",
      "--radius-pill",
      "--font-display",
      "--font-sans",
      "--font-numeric",
    ]) {
      expect(root.has(key), key).toBe(true);
    }
  });
});
