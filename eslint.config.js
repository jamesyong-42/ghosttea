import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/build/**", "**/target/**", "native/vendor/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "packages/ghosttea-react/src/**/*.{ts,tsx}"],
    plugins: reactHooks.configs.flat.recommended.plugins,
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    files: ["**/*.{ts,tsx,mjs}"],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
);
