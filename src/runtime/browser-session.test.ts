import { describe, expect, it } from 'vitest';
import {
  applyBrowserControlConnectionState,
  applyBrowserHttpPlaneState,
  beginBrowserRestoreAfterAuthentication,
  completeBrowserRestore,
  createInitialBrowserRuntimeLifecycleState,
  deriveConnectionBanner,
  type BrowserRuntimeLifecycleState,
} from './browser-session';

function createRestoringState(): BrowserRuntimeLifecycleState {
  let state = createInitialBrowserRuntimeLifecycleState();
  state = applyBrowserControlConnectionState(state, 'disconnected').nextState;
  state = applyBrowserControlConnectionState(state, 'reconnecting').nextState;
  state = applyBrowserControlConnectionState(state, 'connected').nextState;
  return state;
}

describe('browser session lifecycle state', () => {
  it('tracks reconnect attempts and starts restoring after reconnect', () => {
    let state = createInitialBrowserRuntimeLifecycleState();

    const disconnected = applyBrowserControlConnectionState(state, 'disconnected');
    state = disconnected.nextState;
    expect(disconnected.effects).toEqual([
      { kind: 'notify', message: 'Lost connection to the server. Reconnecting...' },
    ]);
    expect(deriveConnectionBanner(state)).toEqual({ state: 'disconnected' });

    const reconnecting = applyBrowserControlConnectionState(state, 'reconnecting');
    state = reconnecting.nextState;
    expect(reconnecting.effects).toEqual([]);
    expect(deriveConnectionBanner(state)).toEqual({ state: 'reconnecting', attempt: 1 });

    const connected = applyBrowserControlConnectionState(state, 'connected');
    state = connected.nextState;
    expect(connected.effects).toEqual([]);
    expect(deriveConnectionBanner(state)).toEqual({ state: 'reconnecting', attempt: 1 });

    const authenticated = beginBrowserRestoreAfterAuthentication(state);
    state = authenticated.nextState;
    expect(authenticated.effects).toEqual([
      { kind: 'start-restore', message: 'Reconnected to the server' },
    ]);
    expect(deriveConnectionBanner(state)).toEqual({ state: 'restoring' });

    state = completeBrowserRestore(state);
    expect(deriveConnectionBanner(state)).toBeNull();
  });

  it('does not emit duplicate disconnect notifications while already reconnecting', () => {
    let state = createInitialBrowserRuntimeLifecycleState();

    state = applyBrowserControlConnectionState(state, 'disconnected').nextState;
    const repeatedDisconnect = applyBrowserControlConnectionState(state, 'disconnected');

    expect(repeatedDisconnect.effects).toEqual([]);
    expect(repeatedDisconnect.nextState.recovery).toEqual({
      kind: 'waiting-for-reconnect',
      attempt: 0,
    });
  });

  it('lets auth-expired override restoring state', () => {
    let state = beginBrowserRestoreAfterAuthentication(createRestoringState()).nextState;
    expect(deriveConnectionBanner(state)).toEqual({ state: 'restoring' });

    state = applyBrowserHttpPlaneState(state, 'auth-expired');
    expect(deriveConnectionBanner(state)).toEqual({ state: 'auth-expired' });
  });

  it('lets a new disconnect override restoring state', () => {
    const state = beginBrowserRestoreAfterAuthentication(createRestoringState()).nextState;
    expect(deriveConnectionBanner(state)).toEqual({ state: 'restoring' });

    const disconnected = applyBrowserControlConnectionState(state, 'disconnected');
    expect(disconnected.effects).toEqual([
      { kind: 'notify', message: 'Lost connection to the server. Reconnecting...' },
    ]);
    expect(deriveConnectionBanner(disconnected.nextState)).toEqual({ state: 'disconnected' });
  });

  it('shows disconnected when only the HTTP command plane is unreachable', () => {
    let state = createInitialBrowserRuntimeLifecycleState();

    state = applyBrowserControlConnectionState(state, 'connected').nextState;
    state = applyBrowserHttpPlaneState(state, 'unreachable');

    expect(deriveConnectionBanner(state)).toEqual({ state: 'disconnected' });
  });

  it('keeps the session in reconnecting until authenticated control traffic confirms restore', () => {
    let state = createInitialBrowserRuntimeLifecycleState();

    state = applyBrowserControlConnectionState(state, 'disconnected').nextState;
    state = applyBrowserControlConnectionState(state, 'reconnecting').nextState;
    state = applyBrowserControlConnectionState(state, 'connected').nextState;

    expect(deriveConnectionBanner(state)).toEqual({ state: 'reconnecting', attempt: 1 });
    expect(beginBrowserRestoreAfterAuthentication(state)).toMatchObject({
      effects: [{ kind: 'start-restore', message: 'Reconnected to the server' }],
      nextState: {
        recovery: { kind: 'restoring' },
      },
    });
  });

  it('survives repeated reconnect cycles without advertising restoring before authentication', () => {
    let state = createInitialBrowserRuntimeLifecycleState();

    for (const _attempt of [1, 2, 3]) {
      state = applyBrowserControlConnectionState(state, 'disconnected').nextState;
      expect(deriveConnectionBanner(state)).toEqual({ state: 'disconnected' });

      state = applyBrowserControlConnectionState(state, 'reconnecting').nextState;
      expect(deriveConnectionBanner(state)).toEqual({ state: 'reconnecting', attempt: 1 });

      state = applyBrowserControlConnectionState(state, 'connected').nextState;
      expect(deriveConnectionBanner(state)).toEqual({ state: 'reconnecting', attempt: 1 });

      state = beginBrowserRestoreAfterAuthentication(state).nextState;
      expect(deriveConnectionBanner(state)).toEqual({ state: 'restoring' });

      state = completeBrowserRestore(state);
      expect(deriveConnectionBanner(state)).toBeNull();
    }
  });
});
