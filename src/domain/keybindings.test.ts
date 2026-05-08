import { describe, expect, it } from 'vitest';
import {
  formatKeyChord,
  getEffectiveKeyChords,
  getKeybindingDefinition,
  parsePersistedKeybindingOverrides,
} from './keybindings';

describe('keybindings', () => {
  it('drops unknown persisted overrides and normalizes valid chords', () => {
    expect(
      parsePersistedKeybindingOverrides({
        version: 1,
        overrides: {
          'app.new-task': {
            chords: [{ key: 'N', cmdOrCtrl: true, alt: false }],
          },
          'unknown.action': {
            chords: [{ key: 'X', cmdOrCtrl: true }],
          },
        },
      }),
    ).toEqual({
      version: 1,
      overrides: {
        'app.new-task': {
          chords: [{ key: 'N', cmdOrCtrl: true }],
        },
      },
    });
  });

  it('resolves overrides and disabled actions against defaults', () => {
    const definition = getKeybindingDefinition('app.new-task');
    expect(definition).toBeDefined();
    if (!definition) {
      return;
    }

    expect(
      formatKeyChord(getEffectiveKeyChords(definition, { version: 1, overrides: {} })[0]),
    ).toBe('Cmd/Ctrl + n');
    expect(
      getEffectiveKeyChords(definition, {
        version: 1,
        overrides: {
          'app.new-task': { chords: null },
        },
      }),
    ).toEqual([]);
  });

  it('keeps disabled actions when parsing persisted overrides', () => {
    expect(
      parsePersistedKeybindingOverrides({
        version: 1,
        overrides: {
          'app.new-task': {
            chords: null,
          },
        },
      }),
    ).toEqual({
      version: 1,
      overrides: {
        'app.new-task': {
          chords: null,
        },
      },
    });
  });
});
