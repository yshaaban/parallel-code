import { IPC } from '../../electron/ipc/channels';
import { invoke, isElectronRuntime } from './ipc';

function logBrowserShellFallback(action: string): void {
  console.warn(`[shell] ${action} is unavailable in browser mode`);
}

export async function revealItemInDir(filePath: string): Promise<void> {
  if (isElectronRuntime()) {
    await invoke(IPC.ShellReveal, { filePath });
    return;
  }
  logBrowserShellFallback('revealItemInDir');
}

export async function openFileInEditor(worktreePath: string, filePath: string): Promise<void> {
  if (isElectronRuntime()) {
    const errorMessage = await invoke<string>(IPC.ShellOpenFile, {
      worktreePath,
      filePath,
    });
    if (errorMessage) throw new Error(errorMessage);
    return;
  }
  logBrowserShellFallback('openFileInEditor');
}

export async function openInEditor(editorCommand: string, worktreePath: string): Promise<void> {
  if (isElectronRuntime()) {
    await invoke(IPC.ShellOpenInEditor, {
      editorCommand,
      worktreePath,
    });
    return;
  }
  logBrowserShellFallback('openInEditor');
}
