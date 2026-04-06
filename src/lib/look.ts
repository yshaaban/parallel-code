export type LookPreset =
  | 'classic'
  | 'graphite'
  | 'midnight'
  | 'indigo'
  | 'ember'
  | 'glacier'
  | 'minimal'
  | 'zenburnesque'
  | 'light';

export interface LookPresetOption {
  id: LookPreset;
  label: string;
  description: string;
}

export const LOOK_PRESETS: LookPresetOption[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Flat monochrome with warm off-white accent',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Cool neon blue with subtle glow',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Graphite with pure black terminals',
  },
  {
    id: 'classic',
    label: 'Classic',
    description: 'Original dark utilitarian look',
  },
  {
    id: 'indigo',
    label: 'Indigo',
    description: 'Deep indigo base with electric violet accents',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm copper highlights and contrast',
  },
  {
    id: 'glacier',
    label: 'Glacier',
    description: 'Clean teal accents with softer depth',
  },
  {
    id: 'zenburnesque',
    label: 'Zenburnesque',
    description: 'Warm sage and muted earth tones',
  },
  {
    id: 'light',
    label: 'Light',
    description: 'Clean white theme with soft blue accents',
  },
];

const LOOK_PRESET_IDS = new Set<string>(LOOK_PRESETS.map((p) => p.id));

export function isLookPreset(value: unknown): value is LookPreset {
  return typeof value === 'string' && LOOK_PRESET_IDS.has(value);
}
