export function isMacUserAgent(userAgent: string): boolean {
  return userAgent.includes('Mac');
}

const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const isApplePlatform = isMacUserAgent(userAgent);
const modifierLabels = isApplePlatform ? { mod: 'Cmd', alt: 'Opt' } : { mod: 'Ctrl', alt: 'Alt' };

export const isMac = isApplePlatform;

/** Display name for the primary modifier key: "Cmd" on macOS, "Ctrl" elsewhere. */
export const mod = modifierLabels.mod;

/** Display name for the Alt/Option key: "Opt" on macOS, "Alt" elsewhere. */
export const alt = modifierLabels.alt;
