import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { showNotification } from '../store/notification';
import { setStore, store } from '../store/state';

export interface MarkdownViewerState {
  agentId?: string;
  content: string;
  fileName?: string;
  relativePath?: string;
  taskId?: string;
  worktreePath?: string;
}

interface OpenMarkdownViewerOptions {
  agentId?: string;
  content?: string;
  fileName?: string;
  relativePath?: string;
  taskId?: string;
  worktreePath?: string;
}

interface BuildMarkdownViewerStateOptions extends OpenMarkdownViewerOptions {
  content: string;
}

function buildMarkdownViewerState(options: BuildMarkdownViewerStateOptions): MarkdownViewerState {
  return {
    content: options.content,
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.fileName !== undefined ? { fileName: options.fileName } : {}),
    ...(options.relativePath !== undefined ? { relativePath: options.relativePath } : {}),
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
    ...(options.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
  };
}

function setMarkdownViewer(options: BuildMarkdownViewerStateOptions): void {
  setStore('markdownViewer', buildMarkdownViewerState(options));
}

export function closeMarkdownViewer(): void {
  if (!store.markdownViewer) {
    return;
  }

  setStore('markdownViewer', null);
}

export async function openMarkdownViewer(options: OpenMarkdownViewerOptions): Promise<boolean> {
  if (options.content !== undefined) {
    setMarkdownViewer({
      ...options,
      content: options.content,
    });
    return true;
  }

  if (!options.worktreePath || !options.relativePath) {
    return false;
  }

  const result = await invoke(IPC.ReadMarkdownFile, {
    relativePath: options.relativePath,
    worktreePath: options.worktreePath,
  }).catch(() => null);
  if (!result) {
    showNotification(`Unable to open markdown file: ${options.relativePath}`);
    return false;
  }

  setMarkdownViewer({
    content: result.content,
    fileName: result.fileName,
    relativePath: result.relativePath,
    worktreePath: options.worktreePath,
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
  });
  return true;
}
