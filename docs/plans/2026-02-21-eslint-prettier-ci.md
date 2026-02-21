# ESLint + Prettier + CI Quality Gates

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add strict ESLint (with TypeScript and SolidJS rules), Prettier formatting, and CI quality gates so every commit is automatically checked for bugs, style violations, and formatting.

**Architecture:** ESLint 9 flat config with `typescript-eslint` strict rules and `eslint-plugin-solid` for SolidJS-specific checks. Prettier handles all formatting. `eslint-config-prettier` disables ESLint formatting rules to avoid conflicts. A new CI workflow runs typecheck + lint + format-check on every push and PR to `main`.

**Tech Stack:** ESLint 9, typescript-eslint, eslint-plugin-solid, Prettier, eslint-config-prettier, GitHub Actions

---

### Task 1: Install ESLint and plugins

**Files:**
- Modify: `package.json`

**Step 1: Install all ESLint-related packages**

Run:
```bash
npm install -D eslint @eslint/js typescript-eslint eslint-plugin-solid @typescript-eslint/parser
```
Expected: packages added to devDependencies in package.json

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install eslint and typescript/solid plugins"
```

---

### Task 2: Install Prettier and ESLint integration

**Files:**
- Modify: `package.json`

**Step 1: Install Prettier and eslint-config-prettier**

Run:
```bash
npm install -D prettier eslint-config-prettier
```
Expected: packages added to devDependencies

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install prettier and eslint-config-prettier"
```

---

### Task 3: Create ESLint flat config

**Files:**
- Create: `eslint.config.js`

**Step 1: Create the ESLint config file**

Create `eslint.config.js` at project root:

```javascript
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";
import * as tsParser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default [
  // Ignore build output
  {
    ignores: ["dist/**", "dist-electron/**", "release/**", "node_modules/**"],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript strict rules (non-type-checked to avoid perf cost in CI)
  ...tseslint.configs.strict,

  // SolidJS-specific rules for TSX files
  {
    files: ["src/**/*.{ts,tsx}"],
    ...solid,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },

  // Electron backend files use Node tsconfig
  {
    files: ["electron/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./electron/tsconfig.json",
      },
    },
  },

  // Custom strict rules
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Prevent `any` — use `unknown` instead
      "@typescript-eslint/no-explicit-any": "error",

      // Require explicit return types on exported functions
      "@typescript-eslint/explicit-module-boundary-types": "off",

      // No unused variables (underscore prefix allowed for intentional skips)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Consistency
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "multi-line"],

      // No console.log (allow warn/error for legitimate error reporting)
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Prevent non-null assertions (prefer explicit checks)
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },

  // Disable rules that conflict with Prettier (must be last)
  eslintConfigPrettier,
];
```

**Step 2: Verify ESLint runs without crashing**

Run:
```bash
npx eslint --max-warnings 0 . 2>&1 | head -50
```
Expected: Either clean output or lint errors (not config/parse errors). If there are errors, that's expected — we'll fix them in a later task.

**Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "chore: add eslint flat config with strict typescript and solid rules"
```

---

### Task 4: Create Prettier config

**Files:**
- Create: `.prettierrc`
- Create: `.prettierignore`

**Step 1: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

**Step 2: Create `.prettierignore`**

```
dist/
dist-electron/
release/
node_modules/
package-lock.json
*.AppImage
*.deb
*.dmg
```

**Step 3: Verify Prettier runs**

Run:
```bash
npx prettier --check "src/**/*.{ts,tsx}" 2>&1 | tail -5
```
Expected: list of files that would be reformatted (expected — we haven't formatted yet)

**Step 4: Commit**

```bash
git add .prettierrc .prettierignore
git commit -m "chore: add prettier config"
```

---

### Task 5: Add npm scripts for lint and format

**Files:**
- Modify: `package.json` (scripts section)

**Step 1: Add lint and format scripts**

Add these scripts to `package.json`:
```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write \"src/**/*.{ts,tsx,css}\" \"electron/**/*.ts\" \"*.{js,json,md}\"",
    "format:check": "prettier --check \"src/**/*.{ts,tsx,css}\" \"electron/**/*.ts\" \"*.{js,json,md}\"",
    "check": "npm run typecheck && npm run lint && npm run format:check"
  }
}
```

Keep all existing scripts. The `check` script runs all quality gates in sequence.

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add lint, format, and check npm scripts"
```

---

### Task 6: Format the entire codebase with Prettier

**Files:**
- Modify: all `.ts`, `.tsx`, `.css`, `.js`, `.json`, `.md` files

**Step 1: Run Prettier on the entire codebase**

Run:
```bash
npm run format
```
Expected: Prettier reformats files. This will be a large diff — that's expected and intentional.

**Step 2: Verify no files are left unformatted**

Run:
```bash
npm run format:check
```
Expected: all files pass

**Step 3: Commit the formatting separately**

```bash
git add -A
git commit -m "style: format entire codebase with prettier"
```

This is a standalone commit so `git blame` can use `--ignore-rev` to skip it.

---

### Task 7: Fix all ESLint errors

**Files:**
- Modify: various `.ts` and `.tsx` files (depends on what ESLint reports)

**Step 1: Run ESLint auto-fix first**

Run:
```bash
npm run lint:fix
```

**Step 2: Check remaining errors**

Run:
```bash
npm run lint 2>&1
```

**Step 3: Fix remaining errors manually**

For each error:
- `no-console` warnings on `console.log` — remove or change to `console.warn`/`console.error`
- `@typescript-eslint/no-explicit-any` — replace with `unknown` or proper type
- `@typescript-eslint/no-non-null-assertion` — add explicit null checks
- `eqeqeq` — replace `==` with `===`
- Other errors — fix case by case, preserving behavior

**Important:** Do NOT disable rules with `eslint-disable` comments unless there is a genuine reason (document it). The goal is to fix the code, not suppress warnings.

**Step 4: Verify clean lint**

Run:
```bash
npm run lint
```
Expected: 0 errors, 0 warnings

**Step 5: Verify typecheck still passes**

Run:
```bash
npm run typecheck
```
Expected: no errors

**Step 6: Commit**

```bash
git add -A
git commit -m "fix: resolve all eslint errors across codebase"
```

---

### Task 8: Add CI quality gate workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "lts/*"
          cache: npm

      - run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check
```

**Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add quality gate workflow with typecheck, lint, and format check"
```

---

### Task 9: Final verification

**Step 1: Run the full quality check**

Run:
```bash
npm run check
```
Expected: typecheck passes, lint passes, format check passes — all three green.

**Step 2: Verify the app still builds**

Run:
```bash
npm run build:frontend
```
Expected: build succeeds without errors

---

## Summary

After completing all tasks, the project will have:

1. **ESLint 9** with strict TypeScript rules, SolidJS-specific rules, and custom rules (`no-any`, `eqeqeq`, `no-console`, `prefer-const`)
2. **Prettier** auto-formatting with a shared config
3. **npm scripts**: `lint`, `lint:fix`, `format`, `format:check`, `check`
4. **CI workflow** running typecheck + lint + format-check on every push/PR to main
5. **Zero existing violations** — everything fixed before merging
