import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "netd/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts, run directly rather than compiled.
    files: ["deploy/dev/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
);
