export type KeybindingActionId =
  | 'navigation.focus-up'
  | 'navigation.focus-down'
  | 'navigation.focus-left'
  | 'navigation.focus-right'
  | 'navigation.task-left'
  | 'navigation.task-right'
  | 'task.move-left'
  | 'task.move-right'
  | 'task.jump-1'
  | 'task.jump-2'
  | 'task.jump-3'
  | 'task.jump-4'
  | 'task.jump-5'
  | 'task.jump-6'
  | 'task.jump-7'
  | 'task.jump-8'
  | 'task.jump-9'
  | 'task.close-focused-terminal'
  | 'task.close-active'
  | 'task.merge'
  | 'task.push'
  | 'task.new-shell'
  | 'task.send-prompt'
  | 'app.new-terminal'
  | 'app.new-task'
  | 'app.new-task-alt'
  | 'app.toggle-sidebar'
  | 'app.toggle-help'
  | 'app.open-settings'
  | 'app.close-dialog'
  | 'app.zoom-in'
  | 'app.zoom-in-alt'
  | 'app.zoom-out'
  | 'app.reset-zoom';

export type KeybindingCategory = 'Navigation' | 'Task Actions' | 'App';

export interface KeyChord {
  alt?: boolean;
  cmdOrCtrl?: boolean;
  ctrl?: boolean;
  key: string;
  shift?: boolean;
}

export interface PersistedKeybindingOverrides {
  overrides: Partial<Record<KeybindingActionId, { chords: KeyChord[] | null }>>;
  version: 1;
}

export interface KeybindingDefinition {
  actionId: KeybindingActionId;
  category: KeybindingCategory;
  defaultChords: KeyChord[];
  description: string;
  dialogSafe?: boolean;
  global?: boolean;
}

const JUMP_ACTIONS = Array.from({ length: 9 }, (_, index) => ({
  actionId: `task.jump-${index + 1}` as KeybindingActionId,
  category: 'Task Actions' as const,
  defaultChords: [
    { key: String(index + 1), cmdOrCtrl: true },
    { key: String(index + 1), cmdOrCtrl: true, shift: true },
  ],
  description: `Jump to task ${index + 1}`,
  global: true,
}));

export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  {
    actionId: 'navigation.focus-up',
    category: 'Navigation',
    defaultChords: [{ key: 'ArrowUp', alt: true }],
    description: 'Focus pane above',
    global: true,
  },
  {
    actionId: 'navigation.focus-down',
    category: 'Navigation',
    defaultChords: [{ key: 'ArrowDown', alt: true }],
    description: 'Focus pane below',
    global: true,
  },
  {
    actionId: 'navigation.focus-left',
    category: 'Navigation',
    defaultChords: [{ key: 'ArrowLeft', alt: true }],
    description: 'Focus sidebar or adjacent task',
    global: true,
  },
  {
    actionId: 'navigation.focus-right',
    category: 'Navigation',
    defaultChords: [{ key: 'ArrowRight', alt: true }],
    description: 'Focus active task or adjacent task',
    global: true,
  },
  {
    actionId: 'navigation.task-left',
    category: 'Navigation',
    defaultChords: [
      { key: 'PageUp', cmdOrCtrl: true },
      { key: 'ArrowLeft', alt: true, cmdOrCtrl: true },
    ],
    description: 'Switch to previous task',
    global: true,
  },
  {
    actionId: 'navigation.task-right',
    category: 'Navigation',
    defaultChords: [
      { key: 'PageDown', cmdOrCtrl: true },
      { key: 'ArrowRight', alt: true, cmdOrCtrl: true },
    ],
    description: 'Switch to next task',
    global: true,
  },
  {
    actionId: 'task.move-left',
    category: 'Task Actions',
    defaultChords: [{ key: 'PageUp', cmdOrCtrl: true, shift: true }],
    description: 'Move task left',
    global: true,
  },
  {
    actionId: 'task.move-right',
    category: 'Task Actions',
    defaultChords: [{ key: 'PageDown', cmdOrCtrl: true, shift: true }],
    description: 'Move task right',
    global: true,
  },
  ...JUMP_ACTIONS,
  {
    actionId: 'task.close-focused-terminal',
    category: 'Task Actions',
    defaultChords: [{ key: 'w', cmdOrCtrl: true }],
    description: 'Close focused terminal',
    global: true,
  },
  {
    actionId: 'task.close-active',
    category: 'Task Actions',
    defaultChords: [{ key: 'W', cmdOrCtrl: true, shift: true }],
    description: 'Close active task or terminal',
    global: true,
  },
  {
    actionId: 'task.merge',
    category: 'Task Actions',
    defaultChords: [{ key: 'M', cmdOrCtrl: true, shift: true }],
    description: 'Merge active task',
    global: true,
  },
  {
    actionId: 'task.push',
    category: 'Task Actions',
    defaultChords: [{ key: 'P', cmdOrCtrl: true, shift: true }],
    description: 'Push to remote',
    global: true,
  },
  {
    actionId: 'task.new-shell',
    category: 'Task Actions',
    defaultChords: [{ key: 'T', cmdOrCtrl: true, shift: true }],
    description: 'New task shell terminal',
    global: true,
  },
  {
    actionId: 'task.send-prompt',
    category: 'Task Actions',
    defaultChords: [{ key: 'Enter', cmdOrCtrl: true }],
    description: 'Send prompt',
    global: true,
  },
  {
    actionId: 'app.new-terminal',
    category: 'App',
    defaultChords: [{ key: 'D', cmdOrCtrl: true, shift: true }],
    description: 'New standalone terminal',
    global: true,
  },
  {
    actionId: 'app.new-task',
    category: 'App',
    defaultChords: [{ key: 'n', cmdOrCtrl: true }],
    description: 'New task',
    global: true,
  },
  {
    actionId: 'app.new-task-alt',
    category: 'App',
    defaultChords: [{ key: 'a', cmdOrCtrl: true, shift: true }],
    description: 'New task',
    global: true,
  },
  {
    actionId: 'app.toggle-sidebar',
    category: 'App',
    defaultChords: [{ key: 'b', cmdOrCtrl: true }],
    description: 'Toggle sidebar',
  },
  {
    actionId: 'app.toggle-help',
    category: 'App',
    defaultChords: [{ key: '/', cmdOrCtrl: true }, { key: 'F1' }],
    description: 'Toggle help',
    dialogSafe: true,
    global: true,
  },
  {
    actionId: 'app.open-settings',
    category: 'App',
    defaultChords: [{ key: ',', cmdOrCtrl: true }],
    description: 'Open settings',
    dialogSafe: true,
    global: true,
  },
  {
    actionId: 'app.close-dialog',
    category: 'App',
    defaultChords: [{ key: 'Escape' }],
    description: 'Close dialogs',
    dialogSafe: true,
  },
  {
    actionId: 'app.zoom-in',
    category: 'App',
    defaultChords: [
      { key: '=', cmdOrCtrl: true },
      { key: '+', cmdOrCtrl: true },
    ],
    description: 'Zoom in',
    dialogSafe: true,
    global: true,
  },
  {
    actionId: 'app.zoom-in-alt',
    category: 'App',
    defaultChords: [{ key: '+', cmdOrCtrl: true, shift: true }],
    description: 'Zoom in',
    dialogSafe: true,
    global: true,
  },
  {
    actionId: 'app.zoom-out',
    category: 'App',
    defaultChords: [{ key: '-', cmdOrCtrl: true }],
    description: 'Zoom out',
    dialogSafe: true,
    global: true,
  },
  {
    actionId: 'app.reset-zoom',
    category: 'App',
    defaultChords: [{ key: '0', cmdOrCtrl: true }],
    description: 'Reset zoom',
    dialogSafe: true,
    global: true,
  },
];

const KEYBINDING_BY_ID = new Map(
  KEYBINDING_DEFINITIONS.map((definition) => [definition.actionId, definition]),
);

export function createDefaultKeybindingOverrides(): PersistedKeybindingOverrides {
  return {
    version: 1,
    overrides: {},
  };
}

export function getKeybindingDefinition(
  actionId: KeybindingActionId,
): KeybindingDefinition | undefined {
  return KEYBINDING_BY_ID.get(actionId);
}

export function isKeybindingActionId(value: string): value is KeybindingActionId {
  return KEYBINDING_BY_ID.has(value as KeybindingActionId);
}

export function getEffectiveKeyChords(
  definition: KeybindingDefinition,
  overrides: PersistedKeybindingOverrides,
): KeyChord[] {
  const override = overrides.overrides[definition.actionId];
  if (override?.chords === null) {
    return [];
  }

  return override?.chords ?? definition.defaultChords;
}

export function normalizeKeyChord(chord: KeyChord): KeyChord {
  return {
    key: chord.key,
    ...(chord.alt === true ? { alt: true } : {}),
    ...(chord.cmdOrCtrl === true ? { cmdOrCtrl: true } : {}),
    ...(chord.ctrl === true ? { ctrl: true } : {}),
    ...(chord.shift === true ? { shift: true } : {}),
  };
}

export function formatKeyChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.cmdOrCtrl) parts.push('Cmd/Ctrl');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(chord.key);
  return parts.join(' + ');
}

export function getKeyChordSignature(chord: KeyChord): string {
  const normalized = normalizeKeyChord(chord);
  return [
    normalized.cmdOrCtrl ? 'mod' : '',
    normalized.ctrl ? 'ctrl' : '',
    normalized.alt ? 'alt' : '',
    normalized.shift ? 'shift' : '',
    normalized.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join('+');
}

export function parsePersistedKeybindingOverrides(value: unknown): PersistedKeybindingOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createDefaultKeybindingOverrides();
  }

  const raw = value as { overrides?: unknown; version?: unknown };
  if (raw.version !== 1 || typeof raw.overrides !== 'object' || raw.overrides === null) {
    return createDefaultKeybindingOverrides();
  }

  const overrides: PersistedKeybindingOverrides['overrides'] = {};
  for (const [actionId, override] of Object.entries(raw.overrides)) {
    if (!isKeybindingActionId(actionId)) {
      continue;
    }

    if (override === null) {
      overrides[actionId] = { chords: null };
      continue;
    }

    if (typeof override !== 'object' || override === null) {
      continue;
    }

    const chords = (override as { chords?: unknown }).chords;
    if (chords === null) {
      overrides[actionId] = { chords: null };
      continue;
    }

    if (!Array.isArray(chords)) {
      continue;
    }

    const parsedChords = chords
      .filter((chord): chord is KeyChord => {
        return typeof chord === 'object' && chord !== null && typeof chord.key === 'string';
      })
      .map((chord) => normalizeKeyChord(chord));
    overrides[actionId] = { chords: parsedChords };
  }

  return {
    version: 1,
    overrides,
  };
}
