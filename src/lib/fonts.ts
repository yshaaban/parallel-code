export const TERMINAL_FONTS = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "Ubuntu Mono",
  "Inconsolata",
  "Hack",
  "Menlo",
  "Consolas",
] as const;

export type TerminalFont = (typeof TERMINAL_FONTS)[number];

export const DEFAULT_TERMINAL_FONT: TerminalFont = "JetBrains Mono";

export function isTerminalFont(v: unknown): v is TerminalFont {
  return typeof v === "string" && (TERMINAL_FONTS as readonly string[]).includes(v);
}

/** Fonts that ship with programming ligatures (disabled in terminal via CSS). */
export const LIGATURE_FONTS: ReadonlySet<TerminalFont> = new Set([
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
]);

export function getTerminalFontFamily(font: TerminalFont): string {
  return `'${font}', monospace`;
}

/** Fonts loaded via Google Fonts — always available regardless of local install. */
const WEB_FONTS: ReadonlySet<TerminalFont> = new Set(["JetBrains Mono"]);

/** Returns the subset of TERMINAL_FONTS that are installed on this system. Cached after first call. */
let availableCache: TerminalFont[] | null = null;

export function getAvailableTerminalFonts(): TerminalFont[] {
  if (availableCache) return availableCache;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    availableCache = [...TERMINAL_FONTS];
    return availableCache;
  }

  const testString = "mmmmmmmmmmlli";
  const fontSize = "72px";
  const fallback = "monospace";

  ctx.font = `${fontSize} ${fallback}`;
  const baseWidth = ctx.measureText(testString).width;

  availableCache = TERMINAL_FONTS.filter((font) => {
    if (WEB_FONTS.has(font)) return true;
    ctx.font = `${fontSize} '${font}', ${fallback}`;
    return ctx.measureText(testString).width !== baseWidth;
  });

  return availableCache;
}
