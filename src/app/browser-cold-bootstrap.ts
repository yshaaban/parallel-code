import { IPC } from '../../electron/ipc/channels';
import type { BrowserColdBootstrapSnapshot } from '../domain/renderer-invoke';
import { invoke, invokeWithAbortSignal } from '../lib/ipc';

export async function fetchBrowserColdBootstrap(
  signal?: AbortSignal,
): Promise<BrowserColdBootstrapSnapshot | null> {
  return signal
    ? invokeWithAbortSignal(IPC.GetBrowserColdBootstrap, signal)
    : invoke(IPC.GetBrowserColdBootstrap);
}
