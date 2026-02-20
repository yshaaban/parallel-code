// Shell operations — wraps Electron shell IPC calls.

export async function revealItemInDir(path: string): Promise<void> {
  await window.electron.ipcRenderer.invoke("__shell_reveal", path);
}
