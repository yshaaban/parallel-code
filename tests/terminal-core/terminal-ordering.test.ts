import { describe, expect, it } from 'vitest';

import {
  createTerminalOrderedState,
  enqueueTerminalOrderedRequest,
  TERMINAL_ORDER_PENDING_LIMIT,
  type TerminalOrderedState,
} from '../../src/terminal-core/terminal-ordering.js';

function enqueueInput(
  state: TerminalOrderedState<string>,
  epoch: string,
  seq: number,
  request: string,
  applied: string[],
): void {
  enqueueTerminalOrderedRequest(
    state,
    {
      inputEpoch: epoch,
      inputSeq: seq,
    },
    request,
    (nextRequest) => {
      applied.push(nextRequest);
    },
  );
}

describe('terminal ordering', () => {
  it('keeps retired epochs for the session so old seq zero packets cannot resurrect', () => {
    const state = createTerminalOrderedState<string>();
    const applied: string[] = [];

    enqueueInput(state, 'old-epoch', 0, 'old-0', applied);
    for (let index = 0; index <= TERMINAL_ORDER_PENDING_LIMIT; index += 1) {
      enqueueInput(state, `new-epoch-${index}`, 0, `new-${index}`, applied);
    }

    enqueueInput(state, 'old-epoch', 0, 'old-resurrected', applied);

    expect(applied).toEqual([
      'old-0',
      ...Array.from({ length: TERMINAL_ORDER_PENDING_LIMIT + 1 }, (_, index) => `new-${index}`),
    ]);
  });

  it('still clears pending requests when one epoch exceeds the gap protection cap', () => {
    const state = createTerminalOrderedState<string>();
    const applied: string[] = [];

    for (let seq = 1; seq <= TERMINAL_ORDER_PENDING_LIMIT + 1; seq += 1) {
      enqueueInput(state, 'gap-epoch', seq, `gap-${seq}`, applied);
    }
    enqueueInput(state, 'gap-epoch', 0, 'gap-0', applied);

    expect(applied).toEqual(['gap-0']);
    expect(state.pending.size).toBe(0);
  });

  it('reports dropped pending requests when the gap protection cap clears the queue', () => {
    const state = createTerminalOrderedState<string>();
    const applied: string[] = [];
    const dropped: string[] = [];

    for (let seq = 1; seq <= TERMINAL_ORDER_PENDING_LIMIT + 1; seq += 1) {
      enqueueTerminalOrderedRequest(
        state,
        {
          inputEpoch: 'gap-epoch',
          inputSeq: seq,
        },
        `gap-${seq}`,
        (nextRequest) => {
          applied.push(nextRequest);
        },
        (nextRequest) => {
          dropped.push(nextRequest);
        },
      );
    }

    expect(applied).toEqual([]);
    expect(dropped).toHaveLength(TERMINAL_ORDER_PENDING_LIMIT + 1);
    expect(state.pending.size).toBe(0);
  });

  it('applies queued requests only after missing earlier sequences arrive', () => {
    const state = createTerminalOrderedState<string>();
    const applied: string[] = [];

    const secondDisposition = enqueueTerminalOrderedRequest(
      state,
      {
        inputEpoch: 'ordered-epoch',
        inputSeq: 1,
      },
      'second',
      (nextRequest) => {
        applied.push(nextRequest);
      },
    );
    const firstDisposition = enqueueTerminalOrderedRequest(
      state,
      {
        inputEpoch: 'ordered-epoch',
        inputSeq: 0,
      },
      'first',
      (nextRequest) => {
        applied.push(nextRequest);
      },
    );

    expect(secondDisposition).toBe('queued');
    expect(firstDisposition).toBe('applied');
    expect(applied).toEqual(['first', 'second']);
  });

  it('queues a new epoch packet that arrives before sequence zero', () => {
    const state = createTerminalOrderedState<string>();
    const applied: string[] = [];

    enqueueInput(state, 'old-epoch', 0, 'old-0', applied);
    const secondDisposition = enqueueTerminalOrderedRequest(
      state,
      {
        inputEpoch: 'new-epoch',
        inputSeq: 1,
      },
      'new-1',
      (nextRequest) => {
        applied.push(nextRequest);
      },
    );
    const firstDisposition = enqueueTerminalOrderedRequest(
      state,
      {
        inputEpoch: 'new-epoch',
        inputSeq: 0,
      },
      'new-0',
      (nextRequest) => {
        applied.push(nextRequest);
      },
    );

    expect(secondDisposition).toBe('queued');
    expect(firstDisposition).toBe('applied');
    expect(applied).toEqual(['old-0', 'new-0', 'new-1']);
  });

  it('acknowledges duplicate active-epoch packets without applying or dropping them', () => {
    const state = createTerminalOrderedState<string>();
    const applied: string[] = [];
    const dropped: string[] = [];
    const duplicates: string[] = [];

    enqueueTerminalOrderedRequest(
      state,
      {
        inputEpoch: 'epoch-1',
        inputSeq: 0,
      },
      'first',
      (nextRequest) => {
        applied.push(nextRequest);
      },
      (nextRequest) => {
        dropped.push(nextRequest);
      },
      (nextRequest) => {
        duplicates.push(nextRequest);
      },
    );
    const duplicateDisposition = enqueueTerminalOrderedRequest(
      state,
      {
        inputEpoch: 'epoch-1',
        inputSeq: 0,
      },
      'first-duplicate',
      (nextRequest) => {
        applied.push(nextRequest);
      },
      (nextRequest) => {
        dropped.push(nextRequest);
      },
      (nextRequest) => {
        duplicates.push(nextRequest);
      },
    );

    expect(duplicateDisposition).toBe('applied');
    expect(applied).toEqual(['first']);
    expect(dropped).toEqual([]);
    expect(duplicates).toEqual(['first-duplicate']);
  });
});
