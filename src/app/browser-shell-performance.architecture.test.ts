import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const appStylesSource = readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');
const remoteIndexSource = readFileSync(
  path.resolve(process.cwd(), 'src/remote/index.html'),
  'utf8',
);
const fontCatalogSource = readFileSync(path.resolve(process.cwd(), 'src/lib/fonts.ts'), 'utf8');

describe('browser shell performance guardrails', () => {
  it('keeps critical browser shells free of remote font dependencies', () => {
    for (const [sourcePath, source] of [
      ['src/styles.css', appStylesSource],
      ['src/remote/index.html', remoteIndexSource],
    ] as const) {
      expect(source, sourcePath).not.toContain('fonts.googleapis');
      expect(source, sourcePath).not.toMatch(/@import\s+url\(['"]?https?:/u);
    }

    expect(fontCatalogSource).toContain('const WEB_FONTS: ReadonlySet<TerminalFont> = new Set()');
  });
});
