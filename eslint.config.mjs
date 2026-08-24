import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"]
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.node,
        ...globals.jest
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" }
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"]
    }
  },
  {
    files: ["src/scripts/**/*.ts"],
    rules: { "no-console": "off" }
  },
  {
    // `import type` is erased before emit, breaking emitDecoratorMetadata.
    files: ["src/entities/**/*.ts", "src/migrations/**/*.ts"],
    rules: { "@typescript-eslint/consistent-type-imports": "off" }
  },
  {
    files: ["src/public/**/*.js", "scripts/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.node,
        firebase: "readonly"
      }
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error", "log"] }]
    }
  }
);
