// Flat ESLint config (ESLint v9+). Lean by design: it parses TS/TSX with the
// typescript-eslint parser and enables the non-type-checked "recommended"
// rules. Type-aware linting is intentionally left off so `pnpm lint` stays
// fast and does not duplicate `pnpm typecheck`.
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "**/target/**",
      "**/coverage/**",
      "apps/desktop/src-tauri/**",
      "**/*.config.*",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    // Pre-existing `// eslint-disable` comments reference rules this lean config
    // doesn't enable (no-console, no-control-regex, etc.); don't nag about them.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Tests and adapter shims lean on `any` for mocks/fixtures; not worth
      // churning. Type safety is enforced by `pnpm typecheck`, not here.
      "@typescript-eslint/no-explicit-any": "off",
      // Honor the `_`-prefix convention for intentionally-unused params/vars.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Real bug catcher — keep at error.
      "react-hooks/rules-of-hooks": "error",
      // Honors the existing `// eslint-disable-next-line react-hooks/exhaustive-deps`
      // comments; surfaces new cases as warnings without failing the gate.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
