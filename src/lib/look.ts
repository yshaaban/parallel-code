export type LookPreset = "classic" | "graphite" | "indigo" | "ember" | "glacier" | "minimal";

export interface LookPresetOption {
  id: LookPreset;
  label: string;
  description: string;
}

export const LOOK_PRESETS: LookPresetOption[] = [
  {
    id: "minimal",
    label: "Minimal",
    description: "Flat monochrome with warm off-white accent",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Cool neon blue with subtle glow",
  },
  {
    id: "classic",
    label: "Classic",
    description: "Original dark utilitarian look",
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "Deep indigo base with electric violet accents",
  },
  {
    id: "ember",
    label: "Ember",
    description: "Warm copper highlights and contrast",
  },
  {
    id: "glacier",
    label: "Glacier",
    description: "Clean teal accents with softer depth",
  },
];

const LOOK_PRESET_IDS = new Set<string>(LOOK_PRESETS.map((p) => p.id));

export function isLookPreset(value: unknown): value is LookPreset {
  return typeof value === "string" && LOOK_PRESET_IDS.has(value);
}
