import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

function listTsxSources(directory: string): string[] {
  return readdirSync(path.resolve(process.cwd(), directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTsxSources(relativePath);
      }
      return entry.isFile() && entry.name.endsWith('.tsx') ? [relativePath] : [];
    },
  );
}

describe('app-wide focus-visible contract', () => {
  it('uses one low-specificity keyboard-focus default with the complete target inventory', () => {
    const styles = readSource('src/styles.css');
    const defaultRule = styles.slice(styles.indexOf(':where('), styles.indexOf('.app-shell'));

    for (const selector of [
      'button',
      'input',
      'select',
      'textarea',
      'a[href]',
      'summary',
      "[contenteditable]:not([contenteditable='false'])",
      "[tabindex]:not([tabindex^='-'])",
      "[role='button']",
      "[role='switch']",
      "[role='checkbox']",
      "[role='link']",
      "[role='menuitem']",
      "[role='menuitemradio']",
      "[role='menuitemcheckbox']",
      "[role='tab']",
      "[role='option']",
      "[role='combobox']",
      "[role='radio']",
      "[role='slider']",
      "[role='treeitem']",
      "[role='textbox']",
    ]) {
      expect(defaultRule).toContain(selector);
    }

    expect(defaultRule).toContain('):focus-visible');
    expect(defaultRule).toContain('outline: 2px solid var(--border-focus)');
    expect(defaultRule).toContain('outline-offset: 2px');
    expect(styles).not.toContain('.dialog-overlay :where(');
    expect(styles).not.toContain('.new-task-placeholder:focus-visible');
  });

  it('forbids first-party inline outline suppression', () => {
    const violations = listTsxSources('src').filter((relativePath) =>
      /outline\s*:\s*['"]none['"]/u.test(readSource(relativePath)),
    );

    expect(violations).toEqual([]);
  });

  it('keeps generated xterm and Monaco focus suppression behind visible shells', () => {
    const styles = readSource('src/styles.css');
    const monaco = readSource('src/components/MonacoDiffEditor.tsx');

    expect(styles).toContain('.focusable-panel:focus-within::after');
    expect(styles).toContain('.focusable-panel .xterm textarea:focus-visible');
    expect(styles).toContain('.monaco-diff-focus-shell .monaco-editor .inputarea:focus-visible');
    expect(styles).toContain('.monaco-diff-focus-shell:focus-within');
    expect(monaco).toContain('class="monaco-diff-focus-shell"');
    expect(styles).not.toMatch(/\.xterm\s+\*[^{]*\{[^}]*outline\s*:\s*none/su);
    expect(styles).not.toMatch(/\.monaco-editor\s+\*[^{]*\{[^}]*outline\s*:\s*none/su);
  });

  it('uses system focus colors in main, remote, and Arena surfaces', () => {
    const styles = readSource('src/styles.css');
    const remote = readSource('src/remote/index.html');
    const remoteDialog = readSource('src/remote/RemoteSessionNameDialog.tsx');
    const arenaConfig = readSource('src/arena/arena-config.css');
    const arenaResults = readSource('src/arena/arena-results.css');

    expect(styles).toContain('@media (forced-colors: active)');
    expect(styles).toContain('outline: 2px solid Highlight !important');
    expect(styles).toContain('.focusable-panel:focus-within::after');
    expect(styles).toContain('border-color: Highlight');

    expect(remoteDialog).toContain('class="remote-session-name-input"');
    expect(remote).toContain('.remote-session-name-input:focus-visible');
    expect(remote).toContain('@media (forced-colors: active)');
    expect(remote).toContain('outline: 2px solid Highlight');

    expect(arenaConfig).toContain('.arena-competitor-input:focus-visible');
    expect(arenaConfig).toContain('.arena-prompt-area:focus-visible');
    expect(arenaConfig).toContain('outline-color: Highlight');
    expect(arenaResults).toContain('.arena-commit-input:focus-visible');
    expect(arenaResults).toContain('outline-color: Highlight');
  });
});
