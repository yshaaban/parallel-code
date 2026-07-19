export type IndexedTaskPanelKind = 'shell' | 'shell-toolbar';

export function parseIndexedTaskPanelId(
  panelId: string | null | undefined,
  kind: IndexedTaskPanelKind,
): number | null {
  if (!panelId) {
    return null;
  }

  const prefix = `${kind}:`;
  if (!panelId.startsWith(prefix)) {
    return null;
  }

  const encodedIndex = panelId.slice(prefix.length);
  if (!/^\d+$/.test(encodedIndex)) {
    return null;
  }

  const index = Number(encodedIndex);
  return Number.isSafeInteger(index) ? index : null;
}
