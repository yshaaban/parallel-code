import { afterEach, describe, expect, it } from 'vitest';

import {
  beginBrowserColdBootstrap,
  cancelBrowserReconnectRestore,
  beginBrowserReconnectRestore,
  completeBrowserReconnectRestore,
  getBrowserStartupState,
  isBrowserColdBootstrapPending,
  markBrowserStartupSelectedTerminalReady,
  resetBrowserStartupStateForTests,
  setBrowserStartupTier,
} from './browser-startup';

describe('browser-startup', () => {
  afterEach(() => {
    resetBrowserStartupStateForTests();
  });

  it('tracks cold bootstrap tiers and background blocking', () => {
    beginBrowserColdBootstrap();
    expect(isBrowserColdBootstrapPending()).toBe(true);
    expect(getBrowserStartupState()).toMatchObject({
      coldBootstrapPending: true,
      currentMode: 'cold-bootstrap',
      tier: 'shell',
    });

    setBrowserStartupTier('summary');
    setBrowserStartupTier('selected-task');
    markBrowserStartupSelectedTerminalReady();

    expect(getBrowserStartupState()).toMatchObject({
      coldBootstrapPending: false,
      currentMode: null,
      tier: 'background',
    });
  });

  it('tracks reconnect restore independently from cold bootstrap', () => {
    beginBrowserReconnectRestore();
    expect(getBrowserStartupState()).toMatchObject({
      currentMode: 'reconnect-restore',
    });

    completeBrowserReconnectRestore();

    expect(getBrowserStartupState()).toMatchObject({
      currentMode: null,
      tier: 'idle',
    });
  });

  it('clears pending cold bootstrap when reconnect restore takes over', () => {
    beginBrowserColdBootstrap();
    setBrowserStartupTier('summary');

    beginBrowserReconnectRestore();
    markBrowserStartupSelectedTerminalReady();

    expect(isBrowserColdBootstrapPending()).toBe(false);
    expect(getBrowserStartupState()).toMatchObject({
      coldBootstrapPending: false,
      currentMode: 'reconnect-restore',
      tier: 'summary',
    });
  });

  it('cancels reconnect restore when transport churn invalidates it', () => {
    beginBrowserReconnectRestore();
    expect(getBrowserStartupState()).toMatchObject({
      currentMode: 'reconnect-restore',
    });

    cancelBrowserReconnectRestore('transport-lost');

    expect(getBrowserStartupState()).toMatchObject({
      currentMode: null,
      tier: 'idle',
    });
  });
});
