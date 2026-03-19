export type DispatchByTypeHandlerMap<TMessage extends { type: string }, TResult = void> = {
  [K in TMessage['type']]: (message: Extract<TMessage, { type: K }>) => TResult;
};

export function dispatchByType<
  TMessage extends { type: string },
  TType extends TMessage['type'],
  TResult,
>(
  handlers: DispatchByTypeHandlerMap<TMessage, TResult>,
  message: Extract<TMessage, { type: TType }>,
): TResult {
  return handlers[message.type](message);
}
