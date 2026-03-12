export type DispatchByTypeHandlerMap<TMessage extends { type: string }, TResult = void> = {
  [K in TMessage['type']]: (message: Extract<TMessage, { type: K }>) => TResult;
};

export function dispatchByType<TMessage extends { type: string }, TResult>(
  handlers: DispatchByTypeHandlerMap<TMessage, TResult>,
  message: TMessage,
): TResult {
  const handler = handlers[message.type as TMessage['type']] as (message: TMessage) => TResult;
  return handler(message);
}
