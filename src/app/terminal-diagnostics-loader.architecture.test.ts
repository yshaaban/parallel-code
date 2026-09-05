import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const entrySource = readFileSync(path.resolve(projectRoot, 'src/index.tsx'), 'utf8');
const loaderSource = readFileSync(
  path.resolve(projectRoot, 'src/app/terminal-diagnostics-loader.ts'),
  'utf8',
);

describe('terminal diagnostics loading boundary', () => {
  it('keeps opt-in capture and UI-fluidity runtimes out of the eager renderer entry', () => {
    expect(entrySource).toContain("from './app/terminal-diagnostics-loader'");
    expect(entrySource).not.toContain("from './app/terminal-diagnostics-capture'");
    expect(entrySource).not.toContain("from './app/ui-fluidity-diagnostics'");
    expect(loaderSource).toContain("import('./terminal-diagnostics-capture')");
    expect(loaderSource).toContain("import('./ui-fluidity-diagnostics')");
  });
});
