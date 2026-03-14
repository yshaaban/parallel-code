export interface PlanSelection {
  endLine: number;
  nearestHeading: string;
  selectedText: string;
  source: string;
  startLine: number;
}

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, tr';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

function getBlockLineNumber(blocks: NodeListOf<Element>, node: Node): number {
  let lineNumber = 1;

  for (const block of blocks) {
    if (block === node || block.contains(node)) {
      return lineNumber;
    }

    const position = block.compareDocumentPosition(node);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      lineNumber += 1;
      continue;
    }

    break;
  }

  return lineNumber;
}

function findNearestHeading(container: HTMLElement, startNode: Node): string {
  let currentNode: Node | null = startNode;

  while (currentNode && currentNode !== container && !(currentNode instanceof HTMLElement)) {
    currentNode = currentNode.parentNode;
  }

  if (!(currentNode instanceof HTMLElement) || currentNode === container) {
    return '';
  }

  if (currentNode.matches(HEADING_SELECTOR)) {
    return currentNode.textContent?.trim() ?? '';
  }

  let currentElement: Element | null = currentNode;
  while (currentElement && container.contains(currentElement)) {
    let sibling: Element | null = currentElement.previousElementSibling;
    while (sibling) {
      if (sibling.matches(HEADING_SELECTOR)) {
        return sibling.textContent?.trim() ?? '';
      }

      const headings = sibling.querySelectorAll(HEADING_SELECTOR);
      if (headings.length > 0) {
        return headings[headings.length - 1]?.textContent?.trim() ?? '';
      }

      sibling = sibling.previousElementSibling;
    }

    currentElement = currentElement.parentElement;
    if (currentElement === container) {
      break;
    }
  }

  return '';
}

export function getPlanSelection(container: HTMLElement, source: string): PlanSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) {
    return null;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) {
    return null;
  }

  const blocks = container.querySelectorAll(BLOCK_SELECTOR);
  const startLine = getBlockLineNumber(blocks, range.startContainer);
  const endLine = getBlockLineNumber(blocks, range.endContainer);

  return {
    source,
    selectedText,
    nearestHeading: findNearestHeading(container, range.startContainer),
    startLine,
    endLine: Math.max(startLine, endLine),
  };
}
