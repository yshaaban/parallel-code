import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const localShellPreferenceKeys = [
  'fontScales',
  'fontSmoothing',
  'globalScale',
  'inactiveColumnOpacity',
  'keybindings',
  'panelSizes',
  'showPlans',
  'sidebarSectionCollapsed',
  'sidebarVisible',
  'taskNotificationsEnabled',
  'taskNotificationsPreferenceInitialized',
  'terminalFont',
  'terminalFontSize',
  'terminalHighLoadMode',
  'terminalLocalInputFeedbackEnabled',
  'themePreset',
  'verboseLogging',
  'windowState',
] as const;

describe('local shell preference ownership', () => {
  it('keeps shared encoding and normalization out of persistence boundary callers', () => {
    const core = readSource('src/store/core.ts');
    const preferenceOwner = readSource('src/store/local-shell-preferences.ts');
    const persistenceCodecs = readSource('src/store/persistence-codecs.ts');
    const persistenceLoad = readSource('src/store/persistence-load.ts');
    const clientSession = readSource('src/store/client-session.ts');
    const browserColdBootstrapProjection = readSource(
      'src/store/browser-cold-bootstrap-projection.ts',
    );

    for (const source of [persistenceCodecs, persistenceLoad, clientSession]) {
      expect(source).toContain("from './local-shell-preferences'");
    }

    expect(core).toContain("from './local-shell-preferences'");
    expect(core).toContain('createDefaultLocalShellPreferences');
    expect(preferenceOwner).not.toContain("from './core'");
    expect(browserColdBootstrapProjection).toContain("from './local-shell-preferences.js'");
    expect(browserColdBootstrapProjection).toContain('applyFullStateLocalShellPreferences');
    expect(browserColdBootstrapProjection).toContain('getLocalShellPreferencesSnapshot');

    for (const key of localShellPreferenceKeys) {
      const directStoreAssignment = new RegExp(`(?:store|storeState)\\.${key}\\s*=`, 'u');
      for (const source of [browserColdBootstrapProjection, persistenceLoad, clientSession]) {
        expect(source).not.toMatch(directStoreAssignment);
      }
      expect(persistenceCodecs).not.toMatch(new RegExp(`persisted\\.${key}`, 'u'));
    }

    expect(clientSession).not.toMatch(/fontScales:\s*\{\s*\.\.\.store\.fontScales/);
    expect(clientSession).not.toMatch(/panelSizes:\s*\{\s*\.\.\.store\.panelSizes/);

    for (const source of [persistenceLoad, clientSession]) {
      expect(source).not.toMatch(/typeof raw\.terminalHighLoadMode/);
      expect(source).not.toMatch(/typeof raw\.sidebarVisible/);
      expect(source).not.toMatch(/normalizeSidebarSectionCollapsedState/);
      expect(source).not.toMatch(/getPersistedTaskNotificationsEnabled/);
      expect(source).not.toMatch(/parsePersistedWindowState/);
    }
  });
});
