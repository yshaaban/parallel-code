import { describe, expect, it } from 'vitest';
import {
  formatKeyChord,
  getEffectiveKeyChords,
  getKeyChordSignature,
  getKeybindingDefinition,
  KEYBINDING_DEFINITIONS,
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

  it('keeps task reorder defaults away from native word-selection chords', () => {
    expect(getKeybindingDefinition('task.move-left')?.defaultChords).toEqual([
      { key: 'PageUp', cmdOrCtrl: true, shift: true },
    ]);
    expect(getKeybindingDefinition('task.move-right')?.defaultChords).toEqual([
      { key: 'PageDown', cmdOrCtrl: true, shift: true },
    ]);

    const forbiddenNativeSelectionChords = new Set(['mod+shift+arrowleft', 'mod+shift+arrowright']);
    for (const actionId of ['task.move-left', 'task.move-right'] as const) {
      const definition = getKeybindingDefinition(actionId);
      expect(definition).toBeDefined();
      for (const chord of definition?.defaultChords ?? []) {
        expect(forbiddenNativeSelectionChords.has(getKeyChordSignature(chord))).toBe(false);
      }
    }
  });

  it('does not ship duplicate default keybinding chords', () => {
    const seen = new Map<string, string>();

    for (const definition of KEYBINDING_DEFINITIONS) {
      for (const chord of definition.defaultChords) {
        const signature = getKeyChordSignature(chord);
        expect(seen.get(signature)).toBeUndefined();
        seen.set(signature, definition.actionId);
      }
    }
  });
});
