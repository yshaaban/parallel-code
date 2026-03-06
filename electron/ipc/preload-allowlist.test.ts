import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { IPC } from './channels.js';
import { diffPreloadAllowedChannels } from './preload-allowlist.js';

describe('preload allowlist', () => {
  it('matches the IPC enum exactly', () => {
    const preloadPath = fileURLToPath(new URL('../preload.cjs', import.meta.url));
    const preloadSource = fs.readFileSync(preloadPath, 'utf8');
    const { missing, extra } = diffPreloadAllowedChannels(preloadSource, Object.values(IPC));

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
