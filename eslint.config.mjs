import { defineConfig, globalIgnores } from "eslint/config";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const providerBoundaryMessage =
  "Only adapters know providers exist (HLD §3.3 rule 2).";

const providerBoundaryPatterns = [
  {
    group: ["@/providers", "@/providers/*"],
    message: providerBoundaryMessage,
  },
  {
    // Relative paths into src/providers, from elsewhere in src or
    // from outside it (`../../src/providers/...`). Static imports
    // only: dynamic import() and require() are not covered.
    regex: "^((\\.\\./)+|\\./)providers(/|$)|(^|/)src/providers(/|$)",
    message: providerBoundaryMessage,
  },
];

const betterAuthBoundaryPattern = {
  group: ["better-auth", "better-auth/*", "@better-auth/*"],
  message:
    "Better Auth is confined to src/identity/auth.ts, src/identity/auth-client.ts and src/server/.",
};

// What every file may not import. The blocks below replace the rule's options
// for their files, so each one repeats what still applies.
const importBoundaryPatterns = [
  ...providerBoundaryPatterns,
  betterAuthBoundaryPattern,
];

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  { settings: { react: { version: "detect" } } },
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  globalIgnores([
    // Build output, and the route tree the Start plugin generates.
    ".output/**",
    ".vercel/**",
    "dist/**",
    "src/routeTree.gen.ts",
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
          patterns: importBoundaryPatterns,
        },
      ],
    },
  },
  {
    files: ["src/lib/clock.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Test helpers parse recorded provider fixtures, and the one-off
    // recording script calls the provider client. Neither is domain code.
    files: ["tests/helpers/**", "scripts/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [betterAuthBoundaryPattern] },
      ],
    },
  },
  {
    // Better Auth's own files may import it; the provider boundary still holds.
    files: [
      "src/identity/auth.ts",
      "src/identity/auth-client.ts",
      "src/server/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: providerBoundaryPatterns },
      ],
    },
  },
  {
    // The Neon Function entry wires the jobs to the providers and the real
    // database, like the replay harness does: the one file in src/jobs that
    // may import src/providers.
    files: ["src/jobs/functions/tick.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [betterAuthBoundaryPattern] },
      ],
    },
  },
  {
    // The scoring engine is pure (HLD §5.6): rules and results in, lines out.
    // It never reads the database, the clock or the filesystem.
    files: ["src/scoring/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...importBoundaryPatterns,
            {
              group: ["@/db", "@/db/*", "drizzle-orm", "drizzle-orm/*"],
              message: "src/scoring is pure: it must not touch the database.",
            },
            {
              group: ["node:*"],
              message: "src/scoring is pure: it must not use Node built-ins.",
            },
          ],
        },
      ],
    },
  },
  {
    // The adapters' own home, and tests of it.
    files: ["src/providers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [betterAuthBoundaryPattern] },
      ],
    },
  },
]);

export default eslintConfig;
