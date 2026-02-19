# Minimal Theme Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Minimal" theme — flat, monochrome dark grays with a warm off-white accent, no gradients or glows.

**Architecture:** Three files to modify: type definition (look.ts), terminal colors (theme.ts), CSS variables + visual overrides (styles.css). Follows the exact pattern of existing themes.

**Tech Stack:** CSS custom properties, TypeScript

---

### Task 1: Add "minimal" to the LookPreset type and preset list

**Files:**
- Modify: `src/lib/look.ts`

**Step 1: Add "minimal" to the LookPreset union type**

```ts
export type LookPreset = "classic" | "graphite" | "indigo" | "ember" | "glacier" | "minimal";
```

**Step 2: Add the preset option to LOOK_PRESETS array**

```ts
{
  id: "minimal",
  label: "Minimal",
  description: "Flat monochrome with warm off-white accent",
},
```

**Step 3: Add "minimal" to the isLookPreset guard**

```ts
export function isLookPreset(value: unknown): value is LookPreset {
  return value === "classic" || value === "graphite" || value === "indigo" || value === "ember" || value === "glacier" || value === "minimal";
}
```

**Step 4: Verify** — `pnpm build` should pass with no type errors.

**Step 5: Commit**

```bash
git add src/lib/look.ts
git commit -m "feat(theme): add minimal preset to LookPreset type"
```

---

### Task 2: Add terminal background for minimal preset

**Files:**
- Modify: `src/lib/theme.ts`

**Step 1: Add minimal entry to terminalBackground record**

```ts
const terminalBackground: Record<LookPreset, string> = {
  classic:  "#1a1b1d",
  graphite: "#121820",
  indigo:   "#121529",
  ember:    "#1b1312",
  glacier:  "#151e26",
  minimal:  "#161616",
};
```

**Step 2: Verify** — `pnpm build` should pass.

**Step 3: Commit**

```bash
git add src/lib/theme.ts
git commit -m "feat(theme): add minimal terminal background color"
```

---

### Task 3: Add CSS variables and visual overrides for minimal theme

**Files:**
- Modify: `src/styles.css`

**Step 1: Add the `html[data-look="minimal"]` block** after the glacier block (line ~232):

```css
html[data-look="minimal"] {
  --font-ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-display: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --bg: #141414;
  --bg-elevated: #1a1a1a;
  --bg-input: #111111;
  --bg-hover: rgba(255,255,255,0.04);
  --bg-selected: rgba(200,191,160,0.12);
  --bg-selected-subtle: rgba(200,191,160,0.06);
  --border: #2a2a2a;
  --border-subtle: #1f1f1f;
  --border-focus: #c8bfa0;
  --fg: #d4d4d4;
  --fg-muted: #777777;
  --fg-subtle: #4a4a4a;
  --accent: #c8bfa0;
  --accent-hover: #d8d0b8;
  --accent-text: #141414;
  --link: #d8d0b8;
  --success: #7a9a6a;
  --error: #b05050;
  --warning: #c8a050;
  --island-bg: #181818;
  --island-border: #252525;
  --island-radius: 10px;
  --task-container-bg: #111111;
  --task-panel-bg: #161616;
  --shadow-soft: 0 1px 3px rgba(0,0,0,0.3);
  --shadow-pop: 0 2px 8px rgba(0,0,0,0.4);
}
```

**Step 2: Add visual overrides** — disable gradient overlay and glow on active columns:

```css
.app-shell[data-look="minimal"]::before {
  opacity: 0 !important;
  background: none !important;
}

.app-shell[data-look="minimal"] .task-column.active {
  box-shadow: none;
  border-color: color-mix(in srgb, var(--border) 85%, transparent) !important;
}
```

**Step 3: Verify** — `pnpm build` should pass.

**Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat(theme): add minimal theme CSS variables and overrides"
```

---

### Task 4: Visual verification

**Step 1:** Run `pnpm dev` and switch to the Minimal theme in Settings.
**Step 2:** Verify: flat background (no gradient), no glow on active columns, warm off-white accent on buttons/focus rings, Inter font, muted semantic colors.
