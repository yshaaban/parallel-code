import { IPC } from '../../electron/ipc/channels';
import type { BrowserColdBootstrapSnapshot } from '../domain/renderer-invoke';
import { invoke } from '../lib/ipc';

export async function fetchBrowserColdBootstrap(): Promise<BrowserColdBootstrapSnapshot | null> {
  return invoke(IPC.GetBrowserColdBootstrap).catch(() => null);
}
