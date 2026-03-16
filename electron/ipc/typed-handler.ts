import type {
  RendererInvokeChannel,
  RendererInvokeRequestMap,
} from '../../src/domain/renderer-invoke.js';
import type { HandlerArgs, IpcHandler } from './handler-context.js';

export type TypedIpcRequest<TChannel extends RendererInvokeChannel> =
  RendererInvokeRequestMap[TChannel];
export type TypedIpcRequestObject<TChannel extends RendererInvokeChannel> = Partial<
  Exclude<TypedIpcRequest<TChannel>, undefined>
>;

export function defineIpcHandler<TChannel extends RendererInvokeChannel>(
  _channel: TChannel,
  handler: (request: TypedIpcRequestObject<TChannel>) => Promise<unknown> | unknown,
): IpcHandler {
  return function typedIpcHandler(args?: HandlerArgs): Promise<unknown> | unknown {
    return handler((args ?? {}) as TypedIpcRequestObject<TChannel>);
  };
}
