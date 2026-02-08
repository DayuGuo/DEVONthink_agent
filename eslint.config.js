// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default tseslint.config(
  // ── 全局忽略 ──────────────────────────────────────────
  {
    ignores: ["dist/", "node_modules/", "*.js", "!eslint.config.js"],
  },

  // ── 基础推荐规则 ──────────────────────────────────────
  eslint.configs.recommended,

  // ── TypeScript 推荐规则 ───────────────────────────────
  ...tseslint.configs.recommended,

  // ── 关闭与 Prettier 冲突的 ESLint 规则 ───────────────
  prettierConfig,

  // ── 项目自定义规则 ────────────────────────────────────
  {
    files: ["src/**/*.ts"],
    plugins: {
      prettier: prettierPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // ─ Prettier 集成（格式问题作为 warning）
      "prettier/prettier": "warn",

      // ─ TypeScript 规则调优
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports" },
      ],

      // ─ 通用质量规则
      "no-console": "off", // CLI 工具需要 console
      "prefer-const": "warn",
      eqeqeq: ["error", "always"],
      "no-throw-literal": "error",
    },
  },
);
