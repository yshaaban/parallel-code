import { isGitHubUrl } from '../lib/github-url';

interface GitHubDragDropOptions {
  isDropOverlayVisible: () => boolean;
  onGitHubUrl: (url: string) => void;
  setDropOverlayVisible: (visible: boolean) => void;
}

function extractGitHubUrl(dataTransfer: DataTransfer): string | null {
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    const firstUrl = uriList
      .split('\n')
      .find((line) => !line.startsWith('#'))
      ?.trim();
    if (firstUrl && isGitHubUrl(firstUrl)) return firstUrl;
  }

  const text = dataTransfer.getData('text/plain')?.trim();
  if (text && isGitHubUrl(text)) return text;
  return null;
}

function mayContainUrl(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.types.includes('Files')) return false;
  return dataTransfer.types.includes('text/uri-list') || dataTransfer.types.includes('text/plain');
}

export function createGitHubDragDropRuntime(options: GitHubDragDropOptions): {
  handleDragEnter: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  handleDragOver: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => void;
} {
  let dragCounter = 0;

  function handleDragEnter(event: DragEvent): void {
    if (!event.dataTransfer || !mayContainUrl(event.dataTransfer)) return;
    event.preventDefault();
    dragCounter += 1;
    if (dragCounter === 1) options.setDropOverlayVisible(true);
  }

  function handleDragOver(event: DragEvent): void {
    if (!options.isDropOverlayVisible()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(_event: DragEvent): void {
    if (!options.isDropOverlayVisible()) return;
    dragCounter -= 1;
    if (dragCounter <= 0) {
      dragCounter = 0;
      options.setDropOverlayVisible(false);
    }
  }

  function handleDrop(event: DragEvent): void {
    event.preventDefault();
    dragCounter = 0;
    options.setDropOverlayVisible(false);
    if (!event.dataTransfer) return;

    const url = extractGitHubUrl(event.dataTransfer);
    if (!url) return;
    options.onGitHubUrl(url);
  }

  return {
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
}
