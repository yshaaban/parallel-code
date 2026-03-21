export function scrollSelectedRowIntoView(
  rowRefs: Array<HTMLDivElement | undefined>,
  selectedIndex: number,
): void {
  if (selectedIndex < 0) {
    return;
  }

  rowRefs[selectedIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
