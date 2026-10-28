import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
    files: ["src/lib/clock.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
