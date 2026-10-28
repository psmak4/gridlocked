import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const providerBoundaryMessage =
  "Only adapters know providers exist (HLD §3.3 rule 2).";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Deliberately violates rules; linted only by tests/lint.
    "tests/lint/fixtures/**",
    // Generated reports and coverage output.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
  ]),
  {
    // All "now" reads go through the injectable clock (src/lib/clock.ts).
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "Use the injectable clock (src/lib/clock.ts).",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Use the injectable clock (src/lib/clock.ts).",
        },
        {
          // Date() without `new` returns the current time as a string.
          selector:
            "CallExpression[callee.type='Identifier'][callee.name='Date']",
          message: "Use the injectable clock (src/lib/clock.ts).",
        },
      ],
    },
  },
  {
    // Only adapters know providers exist (HLD §3.3 rule 2).
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/providers", "@/providers/*"],
              message: providerBoundaryMessage,
            },
            {
              // Relative paths into src/providers, from elsewhere in src or
              // from outside it (`../../src/providers/...`).
              regex: "^(\\.\\./)+providers(/|$)|(^|/)src/providers(/|$)",
              message: providerBoundaryMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/clock.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // The adapters' own home, and tests of it.
    files: ["src/providers/**"],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;
