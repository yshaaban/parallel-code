import type {
  RendererInvokeChannel,
  RendererInvokeRequestMap,
} from '../../src/domain/renderer-invoke.js';
import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import type { HandlerArgs, IpcHandler } from './handler-context.js';

type TypedIpcRequest<TChannel extends RendererInvokeChannel> = Exclude<
  RendererInvokeRequestMap[TChannel],
  undefined
>;

type RequestChannel = {
  [TChannel in RendererInvokeChannel]: RendererInvokeRequestMap[TChannel] extends undefined
    ? never
    : TChannel;
}[RendererInvokeChannel];

const OPTIONAL_REQUEST_CHANNELS: ReadonlySet<RequestChannel> = new Set([
  IPC.DialogOpen,
  IPC.ListAgents,
  IPC.StartRemoteServer,
]);

function getTypedRequest<TChannel extends RequestChannel>(
  channel: TChannel,
  args: HandlerArgs,
): TypedIpcRequest<TChannel> {
  if (args !== undefined) {
    return args as TypedIpcRequest<TChannel>;
  }

  if (OPTIONAL_REQUEST_CHANNELS.has(channel)) {
    return {} as TypedIpcRequest<TChannel>;
  }

  throw new BadRequestError(`Missing request payload for ${channel}`);
}

export function defineIpcHandler<TChannel extends RequestChannel>(
  channel: TChannel,
  handler: (request: TypedIpcRequest<TChannel>) => Promise<unknown> | unknown,
): IpcHandler {
  return function typedIpcHandler(args?: HandlerArgs): Promise<unknown> | unknown {
    return handler(getTypedRequest(channel, args));
  };
}
