import { IPC } from '../../electron/ipc/channels.js';
import type { MarkdownViewerState } from '../domain/markdown-viewer-state.js';
import { invoke } from '../lib/ipc.js';
import { showNotification } from '../store/notification.js';
import { setStore, store } from '../store/state.js';

type OpenMarkdownViewerOptions =
  | {
      agentId?: string;
      content: string;
      fileName?: string;
      relativePath?: string;
      taskId?: string;
      worktreePath?: string;
    }
  | {
      agentId?: string;
      content?: never;
      relativePath: string;
      taskId: string;
    };

interface BuildMarkdownViewerStateOptions {
  agentId?: string;
  content: string;
  fileName?: string;
  relativePath?: string;
  taskId?: string;
  worktreePath?: string;
}

export type MarkdownViewerOpenResult = 'opened' | 'superseded' | 'unavailable';

let openGeneration = 0;

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
  openGeneration += 1;
  if (!store.markdownViewer) {
    return;
  }

  setStore('markdownViewer', null);
}

export async function openMarkdownViewer(
  options: OpenMarkdownViewerOptions,
): Promise<MarkdownViewerOpenResult> {
  const generation = ++openGeneration;
  if (options.content !== undefined) {
    setMarkdownViewer({
      ...options,
      content: options.content,
    });
    return 'opened';
  }

  const result = await invoke(IPC.ReadMarkdownFile, {
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    relativePath: options.relativePath,
    taskId: options.taskId,
  }).catch(() => null);
  if (generation !== openGeneration) {
    return 'superseded';
  }
  if (!result) {
    showNotification(`Unable to open markdown file: ${options.relativePath}`);
    return 'unavailable';
  }

  setMarkdownViewer({
    content: result.content,
    fileName: result.fileName,
    relativePath: result.relativePath,
    worktreePath: result.worktreePath,
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    taskId: options.taskId,
  });
  return 'opened';
}
