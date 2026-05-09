import { describe, expect, it } from 'vitest';

import {
  getCompiledElectronAppRoot,
  getDevelopmentIconPath,
  getElectronPreloadPath,
  getFrontendIndexPath,
} from './main-paths.js';

describe('electron main paths', () => {
  it('resolves packaged resources from the compiled Electron entry directory', () => {
    const compiledMainDir = '/repo/dist-electron/electron';

    expect(getCompiledElectronAppRoot(compiledMainDir)).toBe('/repo');
    expect(getElectronPreloadPath(compiledMainDir)).toBe('/repo/electron/preload.cjs');
    expect(getDevelopmentIconPath(compiledMainDir)).toBe('/repo/build/icon.png');
    expect(getFrontendIndexPath(compiledMainDir)).toBe('/repo/dist/index.html');
  });
});
