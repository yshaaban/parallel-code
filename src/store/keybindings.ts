import { produce } from 'solid-js/store';
import {
  createDefaultKeybindingOverrides,
  getEffectiveKeyChords,
  getKeybindingDefinition,
  KEYBINDING_DEFINITIONS,
  normalizeKeyChord,
  parsePersistedKeybindingOverrides,
  type KeybindingActionId,
  type KeyChord,
  type PersistedKeybindingOverrides,
} from '../domain/keybindings';
import { setStore, store } from './core';

export function normalizeKeybindings(value: unknown): PersistedKeybindingOverrides {
  return parsePersistedKeybindingOverrides(value);
}

export function getKeybindingChords(actionId: KeybindingActionId): KeyChord[] {
  const definition = getKeybindingDefinition(actionId);
  if (!definition) {
    return [];
  }

  return getEffectiveKeyChords(definition, store.keybindings);
}

export function getResolvedKeybindingDefinitions(): Array<{
  actionId: KeybindingActionId;
  category: string;
  chords: KeyChord[];
  description: string;
}> {
  return KEYBINDING_DEFINITIONS.map((definition) => ({
    actionId: definition.actionId,
    category: definition.category,
    chords: getEffectiveKeyChords(definition, store.keybindings),
    description: definition.description,
  }));
}

export function setKeybindingOverride(actionId: KeybindingActionId, chords: KeyChord[]): void {
  setStore(
    produce((state) => {
      state.keybindings.overrides[actionId] = {
        chords: chords.map((chord) => normalizeKeyChord(chord)),
      };
    }),
  );
}

export function disableKeybinding(actionId: KeybindingActionId): void {
  setStore(
    produce((state) => {
      state.keybindings.overrides[actionId] = { chords: null };
    }),
  );
}

export function resetKeybinding(actionId: KeybindingActionId): void {
  setStore(
    produce((state) => {
      delete state.keybindings.overrides[actionId];
    }),
  );
}

export function resetAllKeybindings(): void {
  setStore('keybindings', createDefaultKeybindingOverrides());
}
