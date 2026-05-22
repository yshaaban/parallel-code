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
  traceRequest?: TTrace;
}

export interface OrderedTerminalResizeRequest {
  cols: number;
  rows: number;
}

export const TERMINAL_ORDER_PENDING_LIMIT = 128;

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

function startOrderedEpoch<TRequest>(state: TerminalOrderedState<TRequest>, epoch: string): void {
  if (state.epoch !== null && state.epoch !== epoch) {
    rememberRetiredEpoch(state, state.epoch);
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
): void {
  const epoch = 'inputEpoch' in token ? token.inputEpoch : token.resizeEpoch;
  const seq = 'inputSeq' in token ? token.inputSeq : token.resizeSeq;

  if (state.retiredEpochs.has(epoch)) {
    return;
  }

  if (shouldStartOrderedEpoch(state, epoch, seq)) {
    startOrderedEpoch(state, epoch);
  }

  if (state.epoch !== epoch || seq < state.nextSeq) {
    return;
  }

  if (seq > state.nextSeq) {
    state.pending.set(seq, request);
    if (state.pending.size > TERMINAL_ORDER_PENDING_LIMIT) {
      state.pending.clear();
    }
    return;
  }

  apply(request);
  state.nextSeq += 1;

  while (true) {
    if (!state.pending.has(state.nextSeq)) {
      return;
    }

    const pendingRequest = state.pending.get(state.nextSeq);
    state.pending.delete(state.nextSeq);
    apply(pendingRequest as TRequest);
    state.nextSeq += 1;
  }
}
