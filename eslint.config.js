import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    // Plain JS that runs in Node: the hooks Claude Code executes, and the
    // build scripts. They are not TypeScript, so the core no-undef rule is the
    // only thing checking them and it needs to know what Node provides.
    files: ["plugin/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TypeScript resolves globals and undefined identifiers itself; the core
      // rule has no type info and false-positives on Buffer, etc.
      "no-undef": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];
