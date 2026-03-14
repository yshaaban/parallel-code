import { describe, expect, it } from 'vitest';

import { detectLang } from './shiki-highlighter';

describe('detectLang', () => {
  it('detects languages from special basenames and file extensions', () => {
    expect(detectLang('Dockerfile')).toBe('dockerfile');
    expect(detectLang('src/app.tsx')).toBe('tsx');
    expect(detectLang('scripts/build.sh')).toBe('shellscript');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(detectLang('notes.unknown')).toBe('plaintext');
  });
});
