import type { WebContents } from 'electron';
import type {
  RendererEventChannel,
  RendererIpcEventPayloads,
} from '../../src/domain/renderer-events.js';

export function emitRendererEvent<TChannel extends RendererEventChannel>(
  webContents: Pick<WebContents, 'send'>,
  channel: TChannel,
  payload: RendererIpcEventPayloads[TChannel],
): void {
  webContents.send(channel, payload);
}
