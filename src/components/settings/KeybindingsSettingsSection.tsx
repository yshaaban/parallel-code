import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import {
  formatKeyChord,
  getKeyChordSignature,
  KEYBINDING_DEFINITIONS,
  type KeybindingActionId,
  type KeyChord,
} from '../../domain/keybindings';
import {
  disableKeybinding,
  getResolvedKeybindingDefinitions,
  resetAllKeybindings,
  resetKeybinding,
  setKeybindingOverride,
} from '../../store/keybindings';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import { SectionLabel } from '../SectionLabel';

type ResolvedKeybindingDefinition = ReturnType<typeof getResolvedKeybindingDefinitions>[number];

const DEFAULT_CHORD_SIGNATURES = new Map(
  KEYBINDING_DEFINITIONS.map((definition) => [
    definition.actionId,
    getChordSignatures(definition.defaultChords),
  ]),
);

function createKeyChordFromEvent(event: KeyboardEvent): KeyChord | null {
  if (
    event.key === 'Shift' ||
    event.key === 'Control' ||
    event.key === 'Alt' ||
    event.key === 'Meta'
  ) {
    return null;
  }

  return {
    key: event.key,
    ...(event.altKey ? { alt: true } : {}),
    ...(event.ctrlKey || event.metaKey ? { cmdOrCtrl: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
  };
}

function getChordSignatures(chords: ReadonlyArray<KeyChord>): string {
  return chords.map(getKeyChordSignature).join('|');
}

function formatChordList(chords: ReadonlyArray<KeyChord>): string {
  if (chords.length === 0) {
    return 'Disabled';
  }

  return chords.map(formatKeyChord).join(' or ');
}

function isDefaultKeybinding(
  actionId: KeybindingActionId,
  chords: ReadonlyArray<KeyChord>,
): boolean {
  return DEFAULT_CHORD_SIGNATURES.get(actionId) === getChordSignatures(chords);
}

function groupDefinitionsByCategory(): Array<{
  category: string;
  definitions: ResolvedKeybindingDefinition[];
}> {
  const grouped = new Map<string, ResolvedKeybindingDefinition[]>();
  for (const definition of getResolvedKeybindingDefinitions()) {
    const entries = grouped.get(definition.category) ?? [];
    entries.push(definition);
    grouped.set(definition.category, entries);
  }

  return Array.from(grouped.entries()).map(([category, definitions]) => ({
    category,
    definitions,
  }));
}

function getConflictMessages(): string[] {
  const definitions = getResolvedKeybindingDefinitions();
  const ownerBySignature = new Map<string, string>();
  const conflicts: string[] = [];
  for (const definition of definitions) {
    for (const chord of definition.chords) {
      const signature = getKeyChordSignature(chord);
      const owner = ownerBySignature.get(signature);
      if (owner) {
        conflicts.push(
          `${formatKeyChord(chord)} is shared by ${owner} and ${definition.description}`,
        );
      } else {
        ownerBySignature.set(signature, definition.description);
      }
    }
  }

  return conflicts;
}

export function KeybindingsSettingsSection(): JSX.Element {
  const [capturingActionId, setCapturingActionId] = createSignal<KeybindingActionId | null>(null);
  let stopCapture: (() => void) | undefined;
  const sections = createMemo(() => groupDefinitionsByCategory());
  const conflictMessages = createMemo(() => getConflictMessages());

  function startCapture(actionId: KeybindingActionId): void {
    stopCapture?.();
    setCapturingActionId(actionId);
    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const chord = createKeyChordFromEvent(event);
      if (chord) {
        setKeybindingOverride(actionId, [chord]);
        setCapturingActionId(null);
        stopCapture?.();
        stopCapture = undefined;
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    stopCapture = () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      setCapturingActionId(null);
    };
  }

  onCleanup(() => {
    stopCapture?.();
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
        <SectionLabel>Keybindings</SectionLabel>
        <button
          type="button"
          onClick={() => resetAllKeybindings()}
          style={{
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            color: theme.fg,
            cursor: 'pointer',
            padding: '5px 8px',
            ...typography.metaStrong,
          }}
        >
          Reset all
        </button>
      </div>
      <Show when={conflictMessages().length > 0}>
        <div
          style={{
            color: theme.warning,
            background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
            border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
            'border-radius': '8px',
            padding: '8px 10px',
            ...typography.meta,
          }}
        >
          {conflictMessages()[0]}
        </div>
      </Show>
      <For each={sections()}>
        {(section) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <div style={{ color: theme.fgSubtle, ...typography.label }}>{section.category}</div>
            <For each={section.definitions}>
              {(definition) => {
                const isDefault = isDefaultKeybinding(definition.actionId, definition.chords);

                return (
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns':
                        'minmax(140px, 1fr) minmax(120px, 1fr) auto auto auto',
                      gap: '8px',
                      'align-items': 'center',
                      padding: '7px 8px',
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '8px',
                    }}
                  >
                    <span style={{ color: theme.fg, ...typography.meta }}>
                      {definition.description}
                    </span>
                    <span style={{ color: theme.fgMuted, ...typography.monoMeta }}>
                      {formatChordList(definition.chords)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Record ${definition.description} (${definition.actionId})`}
                      onClick={() => startCapture(definition.actionId)}
                      style={{
                        background: theme.taskPanelBg,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '6px',
                        color:
                          capturingActionId() === definition.actionId ? theme.accent : theme.fg,
                        cursor: 'pointer',
                        padding: '5px 8px',
                        ...typography.metaStrong,
                      }}
                    >
                      {capturingActionId() === definition.actionId ? 'Press keys' : 'Record'}
                    </button>
                    <button
                      type="button"
                      aria-label={`Disable ${definition.description} (${definition.actionId})`}
                      disabled={definition.chords.length === 0}
                      onClick={() => disableKeybinding(definition.actionId)}
                      style={{
                        background: 'transparent',
                        border: `1px solid ${theme.border}`,
                        'border-radius': '6px',
                        color: definition.chords.length === 0 ? theme.fgSubtle : theme.fg,
                        cursor: definition.chords.length === 0 ? 'not-allowed' : 'pointer',
                        padding: '5px 8px',
                        ...typography.meta,
                      }}
                    >
                      Disable
                    </button>
                    <button
                      type="button"
                      aria-label={`Reset ${definition.description} (${definition.actionId})`}
                      disabled={isDefault}
                      onClick={() => resetKeybinding(definition.actionId)}
                      style={{
                        background: 'transparent',
                        border: `1px solid ${theme.border}`,
                        'border-radius': '6px',
                        color: isDefault ? theme.fgSubtle : theme.fg,
                        cursor: isDefault ? 'not-allowed' : 'pointer',
                        padding: '5px 8px',
                        ...typography.meta,
                      }}
                    >
                      Reset
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
