export interface DiffSelection {
  endLine: number;
  filePath: string;
  selectedText: string;
  startLine: number;
}

export function getDiffSelection(): DiffSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  let ancestor: Node | null = range.commonAncestorContainer;

  if (ancestor.nodeType === Node.TEXT_NODE) {
    ancestor = ancestor.parentNode;
  }

  if (!(ancestor instanceof HTMLElement)) {
    return null;
  }

  const singleLine = ancestor.closest?.('[data-new-line]');
  if (singleLine) {
    if (singleLine.getAttribute('data-line-type') === 'remove') {
      return null;
    }

    const lineNumber = Number(singleLine.getAttribute('data-new-line'));
    const filePath = singleLine.getAttribute('data-file-path') ?? '';
    if (!Number.isFinite(lineNumber) || !filePath) {
      return null;
    }

    return {
      filePath,
      startLine: lineNumber,
      endLine: lineNumber,
      selectedText: selection.toString(),
    };
  }

  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      const element = node as HTMLElement;
      if (!element.hasAttribute('data-new-line')) {
        return NodeFilter.FILTER_SKIP;
      }

      if (element.getAttribute('data-line-type') === 'remove') {
        return NodeFilter.FILTER_SKIP;
      }

      if (!range.intersectsNode(element)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  let startLine = Number.POSITIVE_INFINITY;
  let endLine = Number.NEGATIVE_INFINITY;
  let filePath = '';
  const filePaths = new Set<string>();

  while (current) {
    const element = current as HTMLElement;
    const lineNumber = Number(element.getAttribute('data-new-line'));
    const nextFilePath = element.getAttribute('data-file-path') ?? '';

    if (Number.isFinite(lineNumber) && nextFilePath) {
      startLine = Math.min(startLine, lineNumber);
      endLine = Math.max(endLine, lineNumber);
      if (!filePath) {
        filePath = nextFilePath;
      }
      filePaths.add(nextFilePath);
    }

    current = walker.nextNode();
  }

  if (
    !filePath ||
    filePaths.size !== 1 ||
    !Number.isFinite(startLine) ||
    !Number.isFinite(endLine)
  ) {
    return null;
  }

  return {
    filePath,
    startLine,
    endLine,
    selectedText: selection.toString(),
  };
}
