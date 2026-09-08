import { createRoot, createSignal, untrack } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { snapshotMock, saveStateMock } = vi.hoisted(() => ({
  snapshotMock: vi.fn<() => string>(),
  saveStateMock: vi.fn<() => Promise<void>>(),
}));

vi.mock('../lib/ipc', () => ({ isElectronRuntime: () => true }));
vi.mock('./persistence', () => ({
  getWorkspaceStateSnapshotJson: snapshotMock,
  saveState: saveStateMock,
  saveBrowserWorkspaceStateSnapshot: vi.fn(),
}));
vi.mock('./client-session', () => ({
  getClientSessionStateSnapshotJson: () => '{}',
  saveClientSessionState: vi.fn(),
}));

import { hasPendingWorkspaceAutosaveChanges, markAutosaveClean, setupAutosave } from './autosave';

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  snapshotMock.mockReset();
  saveStateMock.mockReset();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  markAutosaveClean();
  vi.useRealTimers();
});

describe('desktop autosave scheduling', () => {
  it('acknowledges only the submitted snapshot and saves edits made during the pending request', async () => {
    const [snapshot, setSnapshot] = createSignal('base');
    // setupAutosave reads this adapter from its tracked effect.
    // eslint-disable-next-line solid/reactivity
    snapshotMock.mockImplementation(snapshot);
    const submitted: string[] = [];
    let finishFirst!: () => void;
    saveStateMock.mockImplementation(() => {
      submitted.push(untrack(snapshot));
      return submitted.length === 1
        ? new Promise<void>((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve();
    });
    createRoot((cleanup) => {
      dispose = cleanup;
      setupAutosave();
    });
    setSnapshot('edit-A');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitted).toEqual(['edit-A']);
    setSnapshot('edit-B');
    expect(hasPendingWorkspaceAutosaveChanges()).toBe(true);
    finishFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingWorkspaceAutosaveChanges()).toBe(true);
    expect(submitted).toEqual(['edit-A']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(submitted).toEqual(['edit-A', 'edit-B']);
    expect(hasPendingWorkspaceAutosaveChanges()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(submitted).toHaveLength(2);
  });

  it('does not let a late acknowledgement dirty or clean a replaced autosave generation', async () => {
    const [snapshot, setSnapshot] = createSignal('base');
    // setupAutosave reads this adapter from its tracked effect.
    // eslint-disable-next-line solid/reactivity
    snapshotMock.mockImplementation(snapshot);
    let finish!: () => void;
    saveStateMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    createRoot((cleanup) => {
      dispose = cleanup;
      setupAutosave();
    });
    setSnapshot('edit-A');
    await vi.advanceTimersByTimeAsync(1_000);
    setSnapshot('canonical replacement');
    markAutosaveClean();
    setSnapshot('edit after replacement');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingWorkspaceAutosaveChanges()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saveStateMock).toHaveBeenCalledTimes(2);
    expect(hasPendingWorkspaceAutosaveChanges()).toBe(false);
  });
});
