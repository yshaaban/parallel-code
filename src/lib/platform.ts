export const isMac = navigator.userAgent.includes("Mac");

/** Display name for the primary modifier key: "Cmd" on macOS, "Ctrl" elsewhere. */
export const mod = isMac ? "Cmd" : "Ctrl";

/** Display name for the Alt/Option key: "Opt" on macOS, "Alt" elsewhere. */
export const alt = isMac ? "Opt" : "Alt";
