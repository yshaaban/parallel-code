export interface TerminalInputOrderToken {
  inputEpoch?: string;
  inputSeq?: number;
}

export interface TerminalResizeOrderToken {
  resizeEpoch?: string;
  resizeSeq?: number;
}

export interface OrderedTerminalInputRequest<TTrace = unknown> {
  data: string;
  onApplied?: () => void;
  onDropped?: () => void;
  traceRequest?: TTrace;
}

export interface OrderedTerminalResizeRequest {
  cols: number;
  onApplied?: () => void;
  onDropped?: () => void;
  rows: number;
}

export const TERMINAL_ORDER_PENDING_LIMIT = 128;

export type TerminalOrderedRequestDisposition = 'applied' | 'dropped' | 'queued';

export interface TerminalOrderedState<TRequest> {
  epoch: string | null;
  nextSeq: number;
  pending: Map<number, TRequest>;
  retiredEpochs: Set<string>;
}

export function hasTerminalInputOrder(
  token: TerminalInputOrderToken | undefined,
): token is Required<TerminalInputOrderToken> {
  return typeof token?.inputEpoch === 'string' && typeof token.inputSeq === 'number';
}

export function hasTerminalResizeOrder(
  token: TerminalResizeOrderToken | undefined,
): token is Required<TerminalResizeOrderToken> {
  return typeof token?.resizeEpoch === 'string' && typeof token.resizeSeq === 'number';
}

export function createTerminalOrderedState<TRequest>(): TerminalOrderedState<TRequest> {
  return {
    epoch: null,
    nextSeq: 0,
    pending: new Map(),
    retiredEpochs: new Set(),
  };
}

function shouldStartOrderedEpoch<TRequest>(
  state: TerminalOrderedState<TRequest>,
  epoch: string,
  seq: number,
): boolean {
  if (state.epoch === null) {
    return true;
  }

  return state.epoch !== epoch && seq === 0;
}

function rememberRetiredEpoch<TRequest>(
  state: TerminalOrderedState<TRequest>,
  epoch: string,
): void {
  state.retiredEpochs.add(epoch);
}

function startOrderedEpoch<TRequest>(
  state: TerminalOrderedState<TRequest>,
  epoch: string,
  onDrop?: (request: TRequest) => void,
): void {
  if (state.epoch !== null && state.epoch !== epoch) {
    rememberRetiredEpoch(state, state.epoch);
    for (const pendingRequest of state.pending.values()) {
      onDrop?.(pendingRequest);
    }
  }

  state.epoch = epoch;
  state.nextSeq = 0;
  state.pending.clear();
}

export function enqueueTerminalOrderedRequest<TRequest>(
  state: TerminalOrderedState<TRequest>,
  token: Required<TerminalInputOrderToken> | Required<TerminalResizeOrderToken>,
  request: TRequest,
  apply: (request: TRequest) => void,
  onDrop?: (request: TRequest) => void,
): TerminalOrderedRequestDisposition {
  const epoch = 'inputEpoch' in token ? token.inputEpoch : token.resizeEpoch;
  const seq = 'inputSeq' in token ? token.inputSeq : token.resizeSeq;

  if (state.retiredEpochs.has(epoch)) {
    onDrop?.(request);
    return 'dropped';
  }

  if (shouldStartOrderedEpoch(state, epoch, seq)) {
    startOrderedEpoch(state, epoch, onDrop);
  }

  if (state.epoch !== epoch || seq < state.nextSeq) {
    onDrop?.(request);
    return 'dropped';
  }

  if (seq > state.nextSeq) {
    const replacedRequest = state.pending.get(seq);
    if (replacedRequest !== undefined) {
      onDrop?.(replacedRequest);
    }
    state.pending.set(seq, request);
    if (state.pending.size > TERMINAL_ORDER_PENDING_LIMIT) {
      for (const pendingRequest of state.pending.values()) {
        onDrop?.(pendingRequest);
      }
      state.pending.clear();
      return 'dropped';
    }
    return 'queued';
  }

  apply(request);
  state.nextSeq += 1;

  while (true) {
    if (!state.pending.has(state.nextSeq)) {
      return 'applied';
    }

    const pendingRequest = state.pending.get(state.nextSeq);
    state.pending.delete(state.nextSeq);
    apply(pendingRequest as TRequest);
    state.nextSeq += 1;
  }
}
