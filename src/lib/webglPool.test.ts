import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { platformState, webglAddonInstances } = vi.hoisted(() => ({
  platformState: { isMac: false },
  webglAddonInstances: [] as MockWebglAddon[],
}));

vi.mock('./platform', () => ({
  get isMac() {
    return platformState.isMac;
  },
}));

vi.mock('@xterm/addon-webgl', () => {
  class MockWebglAddon {
    private onContextLossCb: (() => void) | undefined;

    clearTextureAtlas = vi.fn();
    dispose = vi.fn();

    constructor() {
      webglAddonInstances.push(this);
    }

    onContextLoss(cb: () => void): void {
      this.onContextLossCb = cb;
    }

    triggerContextLoss(): void {
      this.onContextLossCb?.();
    }
  }

  return { WebglAddon: MockWebglAddon };
});

type MockTerminal = {
  rows: number;
  loadAddon: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
};

type MockWebglAddon = {
  clearTextureAtlas: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  triggerContextLoss: () => void;
};

function createTerminal(): MockTerminal {
  return {
    rows: 24,
    loadAddon: vi.fn(),
    refresh: vi.fn(),
  };
}

function asTerminal(terminal: MockTerminal): Terminal {
  return terminal as unknown as Terminal;
}

async function importReadyWebglPool(): Promise<typeof import('./webglPool')> {
  const module = await import('./webglPool');
  await module.preloadWebglAddon();
  return module;
}

describe('webglPool', () => {
  let agentIdPrefix = '';
  let animationFrameId = 0;
  let documentFocused = true;
  let documentVisibility: DocumentVisibilityState = 'visible';
  const animationFrames = new Map<number, FrameRequestCallback>();

  function flushNextAnimationFrame(): void {
    const next = [...animationFrames.entries()].sort(([left], [right]) => left - right)[0];
    if (!next) {
      throw new Error('Expected a pending animation frame');
    }
    const [id, callback] = next;
    animationFrames.delete(id);
    callback(performance.now());
  }

  function getAgentId(index: number): string {
    return `${agentIdPrefix}-${index}`;
  }

  beforeEach(() => {
    platformState.isMac = false;
    webglAddonInstances.length = 0;
    agentIdPrefix = `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    animationFrameId = 0;
    animationFrames.clear();
    documentFocused = true;
    documentVisibility = 'visible';
    vi.clearAllTimers();
    vi.clearAllMocks();
    vi.resetModules();
    const fakeWindow = new EventTarget() as EventTarget & {
      __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    };
    fakeWindow.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: fakeWindow,
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        animationFrameId += 1;
        animationFrames.set(animationFrameId, callback);
        return animationFrameId;
      }),
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn((id: number) => {
        animationFrames.delete(id);
      }),
    });
    const fakeDocument = new EventTarget();
    Object.defineProperty(fakeDocument, 'hasFocus', {
      configurable: true,
      value: () => documentFocused,
    });
    Object.defineProperty(fakeDocument, 'visibilityState', {
      configurable: true,
      get: () => documentVisibility,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: fakeDocument,
    });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    const { releaseWebglAddon } = await importReadyWebglPool();
    for (let i = 0; i < 8; i++) {
      releaseWebglAddon(getAgentId(i));
    }
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });

  it('loads the WebGL addon runtime on demand before acquiring contexts', async () => {
    const module = await import('./webglPool');
    const terminal = createTerminal();

    expect(module.isWebglAddonRuntimeReady()).toBe(false);
    expect(module.acquireWebglAddon(getAgentId(0), asTerminal(terminal))).toBeNull();

    await module.preloadWebglAddon();

    expect(module.isWebglAddonRuntimeReady()).toBe(true);
    expect(module.acquireWebglAddon(getAgentId(0), asTerminal(terminal))).not.toBeNull();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
  });

  it('touches active terminals so eviction is true LRU within the same priority', async () => {
    const { acquireWebglAddon, touchWebglAddon } = await importReadyWebglPool();
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let i = 0; i < 6; i++) {
      acquireWebglAddon(getAgentId(i), asTerminal(terminals[i]));
    }

    touchWebglAddon(getAgentId(0));
    acquireWebglAddon(getAgentId(6), asTerminal(terminals[6]));

    expect(terminals[0].refresh).not.toHaveBeenCalled();
    expect(terminals[1].refresh).toHaveBeenCalledTimes(1);
  });

  it('preserves focused terminals ahead of background terminals during eviction', async () => {
    const { acquireWebglAddon, setWebglAddonPriority } = await importReadyWebglPool();
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let index = 0; index < 6; index += 1) {
      acquireWebglAddon(getAgentId(index), asTerminal(terminals[index]));
      setWebglAddonPriority(getAgentId(index), index === 0 ? 'focused' : 'background');
    }

    acquireWebglAddon(getAgentId(6), asTerminal(terminals[6]));
    setWebglAddonPriority(getAgentId(6), 'background');

    expect(terminals[0].refresh).not.toHaveBeenCalled();
    expect(terminals[1].refresh).toHaveBeenCalledTimes(1);
  });

  it('does not fire renderer-lost recovery during explicit release', async () => {
    const { acquireWebglAddon, releaseWebglAddon } = await importReadyWebglPool();
    const onRendererLost = vi.fn();

    acquireWebglAddon(getAgentId(0), asTerminal(createTerminal()), onRendererLost);
    releaseWebglAddon(getAgentId(0));
    await Promise.resolve();

    expect(onRendererLost).not.toHaveBeenCalled();
  });

  it('disposes an unpublished addon exactly once when xterm rejects it', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot, releaseWebglAddon } =
      await importReadyWebglPool();
    const terminal = createTerminal();
    terminal.loadAddon.mockImplementationOnce(() => {
      throw new Error('activation failed');
    });

    expect(acquireWebglAddon(getAgentId(0), asTerminal(terminal))).toBeNull();

    const addon = webglAddonInstances.at(-1);
    expect(addon?.dispose).toHaveBeenCalledTimes(1);
    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });

    releaseWebglAddon(getAgentId(0));
    expect(addon?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes and rejects an addon whose context is lost synchronously during load', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot } = await importReadyWebglPool();
    const terminal = createTerminal();
    const onRendererLost = vi.fn();
    terminal.loadAddon.mockImplementationOnce((addon: MockWebglAddon) => {
      addon.triggerContextLoss();
    });

    expect(acquireWebglAddon(getAgentId(0), asTerminal(terminal), onRendererLost)).toBeNull();

    expect(webglAddonInstances.at(-1)?.dispose).toHaveBeenCalledTimes(1);
    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 0,
      visibleContextsCurrent: 0,
    });
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(onRendererLost).not.toHaveBeenCalled();
  });

  it('ignores a stale context-loss callback after the agent acquires a replacement', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot, releaseWebglAddon } =
      await importReadyWebglPool();
    const terminal = createTerminal();
    const onRendererLost = vi.fn();
    const firstAddon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(terminal),
      onRendererLost,
    ) as unknown as MockWebglAddon;
    releaseWebglAddon(getAgentId(0));
    const replacementAddon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(terminal),
      onRendererLost,
    ) as unknown as MockWebglAddon;

    firstAddon.triggerContextLoss();
    await Promise.resolve();

    expect(acquireWebglAddon(getAgentId(0), asTerminal(terminal))).toBe(replacementAddon);
    expect(replacementAddon.dispose).not.toHaveBeenCalled();
    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 1,
      visibleContextsCurrent: 0,
    });
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(onRendererLost).not.toHaveBeenCalled();
  });

  it('protects focused terminals from background eviction', async () => {
    const { acquireWebglAddon, setWebglAddonPriority } = await importReadyWebglPool();
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let index = 0; index < 6; index += 1) {
      acquireWebglAddon(getAgentId(index), asTerminal(terminals[index]));
    }

    setWebglAddonPriority(getAgentId(0), 'focused');
    acquireWebglAddon(getAgentId(6), asTerminal(terminals[6]));

    expect(terminals[0].refresh).not.toHaveBeenCalled();
    expect(terminals[1].refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the terminal and notifies recovery handlers on context loss', async () => {
    const { acquireWebglAddon } = await importReadyWebglPool();
    const term = createTerminal();
    const onRendererLost = vi.fn();

    const addon = acquireWebglAddon(getAgentId(0), asTerminal(term), onRendererLost) as {
      triggerContextLoss: () => void;
    } | null;

    expect(addon).not.toBeNull();
    addon?.triggerContextLoss();
    await Promise.resolve();

    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1);
    expect(onRendererLost).toHaveBeenCalledTimes(1);

    const replacement = acquireWebglAddon(getAgentId(0), asTerminal(term), onRendererLost);
    expect(replacement).not.toBe(addon);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
  });

  it('records renderer churn counters through real pool operations', async () => {
    const { getRendererRuntimeDiagnosticsSnapshot, resetRendererRuntimeDiagnostics } =
      await import('../app/runtime-diagnostics');
    const { acquireWebglAddon, releaseWebglAddon, setWebglAddonPriority } =
      await importReadyWebglPool();

    resetRendererRuntimeDiagnostics();
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let index = 0; index < 6; index += 1) {
      acquireWebglAddon(getAgentId(index), asTerminal(terminals[index]));
      setWebglAddonPriority(getAgentId(index), index < 2 ? 'visible' : 'background');
    }

    acquireWebglAddon(getAgentId(6), asTerminal(terminals[6]));
    releaseWebglAddon(getAgentId(6));

    expect(getRendererRuntimeDiagnosticsSnapshot().terminalRenderer).toEqual(
      expect.objectContaining({
        acquireAttempts: 7,
        acquireHits: 7,
        acquireMisses: 0,
        activeContextsCurrent: 5,
        activeContextsMax: 6,
        explicitReleases: 1,
        fallbackActivations: 1,
        fallbackRecoveries: 0,
        visibleContextsCurrent: 2,
        visibleContextsMax: 2,
        webglEvictions: 1,
      }),
    );
  });

  it('allows focused terminals to evict the least-recently-used visible context', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot, setWebglAddonPriority } =
      await importReadyWebglPool();
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let index = 0; index < 6; index += 1) {
      const addon = acquireWebglAddon(getAgentId(index), asTerminal(terminals[index]));
      expect(addon).not.toBeNull();
      setWebglAddonPriority(getAgentId(index), 'visible');
    }

    const focusedAddon = acquireWebglAddon(
      getAgentId(6),
      asTerminal(terminals[6]),
      undefined,
      'focused',
    );

    expect(focusedAddon).not.toBeNull();
    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 6,
      visibleContextsCurrent: 6,
    });
    expect(terminals[0]?.refresh).toHaveBeenCalledTimes(1);
    for (let index = 1; index < 6; index += 1) {
      expect(terminals[index]?.refresh).not.toHaveBeenCalled();
    }
    expect(terminals[6]?.refresh).not.toHaveBeenCalled();
  });

  it('honors a visible context limit by falling back without eviction', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot, setWebglAddonPriority } =
      await importReadyWebglPool();
    const terminals = Array.from({ length: 5 }, () => createTerminal());

    for (let index = 0; index < 4; index += 1) {
      const addon = acquireWebglAddon(
        getAgentId(index),
        asTerminal(terminals[index]),
        undefined,
        'visible',
        { visibleContextLimit: 4 },
      );
      expect(addon).not.toBeNull();
      setWebglAddonPriority(getAgentId(index), 'visible');
    }

    const refusedAddon = acquireWebglAddon(
      getAgentId(4),
      asTerminal(terminals[4]),
      undefined,
      'visible',
      { visibleContextLimit: 4 },
    );

    expect(refusedAddon).toBeNull();
    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 4,
      visibleContextsCurrent: 4,
    });
    for (const terminal of terminals) {
      expect(terminal.refresh).not.toHaveBeenCalled();
    }
  });

  it('enforces priority and visible limits when reacquiring an existing context', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot } = await importReadyWebglPool();
    const terminals = Array.from({ length: 3 }, () => createTerminal());

    expect(
      acquireWebglAddon(getAgentId(0), asTerminal(terminals[0]), undefined, 'background'),
    ).not.toBeNull();
    expect(
      acquireWebglAddon(getAgentId(1), asTerminal(terminals[1]), undefined, 'visible', {
        visibleContextLimit: 1,
      }),
    ).not.toBeNull();

    expect(
      acquireWebglAddon(getAgentId(0), asTerminal(terminals[0]), undefined, 'visible', {
        visibleContextLimit: 1,
      }),
    ).toBeNull();

    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 1,
      visibleContextsCurrent: 1,
    });
    expect(terminals[0].refresh).toHaveBeenCalledTimes(1);
  });

  it('evicts a focused context instead of retaining it over the visible context limit', async () => {
    const { acquireWebglAddon, getWebglPoolRuntimeSnapshot, setWebglAddonPriority } =
      await importReadyWebglPool();
    const terminals = Array.from({ length: 5 }, () => createTerminal());

    for (let index = 0; index < 4; index += 1) {
      expect(
        acquireWebglAddon(getAgentId(index), asTerminal(terminals[index]), undefined, 'visible', {
          visibleContextLimit: 4,
        }),
      ).not.toBeNull();
    }
    expect(
      acquireWebglAddon(getAgentId(4), asTerminal(terminals[4]), undefined, 'focused'),
    ).not.toBeNull();

    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 5,
      visibleContextsCurrent: 5,
    });

    expect(setWebglAddonPriority(getAgentId(4), 'visible', { visibleContextLimit: 4 })).toBe(false);

    expect(getWebglPoolRuntimeSnapshot()).toEqual({
      activeContextsCurrent: 4,
      visibleContextsCurrent: 4,
    });
    expect(terminals[4].refresh).toHaveBeenCalledTimes(1);
  });

  it('queues visible contexts once and repairs focused-first at one entry per frame', async () => {
    const { acquireWebglAddon, requestVisibleWebglAtlasRepair, setWebglAddonPriority } =
      await importReadyWebglPool();
    const terminals = Array.from({ length: 3 }, () => createTerminal());
    const addons = terminals.map(
      (terminal, index) =>
        acquireWebglAddon(getAgentId(index), asTerminal(terminal)) as unknown as MockWebglAddon,
    );
    setWebglAddonPriority(getAgentId(0), 'visible');
    setWebglAddonPriority(getAgentId(1), 'focused');
    setWebglAddonPriority(getAgentId(2), 'background');

    expect(requestVisibleWebglAtlasRepair('manual')).toBe(2);
    expect(requestVisibleWebglAtlasRepair('manual')).toBe(0);
    expect(animationFrames.size).toBe(1);

    flushNextAnimationFrame();
    expect(addons[1]?.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(terminals[1]?.refresh).toHaveBeenCalledWith(0, 23);
    expect(addons[0]?.clearTextureAtlas).not.toHaveBeenCalled();
    expect(addons[2]?.clearTextureAtlas).not.toHaveBeenCalled();
    expect(addons[1]?.clearTextureAtlas.mock.invocationCallOrder[0]).toBeLessThan(
      terminals[1]?.refresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(animationFrames.size).toBe(1);

    flushNextAnimationFrame();
    expect(addons[0]?.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(terminals[0]?.refresh).toHaveBeenCalledWith(0, 23);
    expect(animationFrames.size).toBe(0);
  });

  it('rechecks visibility, row eligibility, and generation identity before repair', async () => {
    const {
      acquireWebglAddon,
      requestVisibleWebglAtlasRepair,
      releaseWebglAddon,
      setWebglAddonPriority,
    } = await importReadyWebglPool();
    const hiddenTerminal = createTerminal();
    const zeroRowTerminal = createTerminal();
    const replacedTerminal = createTerminal();
    const hiddenAddon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(hiddenTerminal),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;
    const zeroRowAddon = acquireWebglAddon(
      getAgentId(1),
      asTerminal(zeroRowTerminal),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;
    const replacedAddon = acquireWebglAddon(
      getAgentId(2),
      asTerminal(replacedTerminal),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;

    expect(requestVisibleWebglAtlasRepair('manual')).toBe(3);
    setWebglAddonPriority(getAgentId(0), 'background');
    zeroRowTerminal.rows = 0;
    releaseWebglAddon(getAgentId(2));
    const replacement = createTerminal();
    const replacementAddon = acquireWebglAddon(
      getAgentId(2),
      asTerminal(replacement),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;

    while (animationFrames.size > 0) {
      flushNextAnimationFrame();
    }

    expect(hiddenAddon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(zeroRowAddon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(replacedAddon.clearTextureAtlas).not.toHaveBeenCalled();
    expect(replacementAddon.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it('isolates atlas failures and continues draining later entries', async () => {
    const { acquireWebglAddon, requestVisibleWebglAtlasRepair } = await importReadyWebglPool();
    const firstTerminal = createTerminal();
    const secondTerminal = createTerminal();
    const firstAddon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(firstTerminal),
      undefined,
      'focused',
    ) as unknown as MockWebglAddon;
    const secondAddon = acquireWebglAddon(
      getAgentId(1),
      asTerminal(secondTerminal),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;
    firstAddon.clearTextureAtlas.mockImplementationOnce(() => {
      throw new Error('atlas failure');
    });

    expect(requestVisibleWebglAtlasRepair('manual')).toBe(2);
    flushNextAnimationFrame();
    flushNextAnimationFrame();

    expect(firstTerminal.refresh).not.toHaveBeenCalled();
    expect(secondAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(secondTerminal.refresh).toHaveBeenCalledTimes(1);
  });

  it('repairs once for a macOS foreground edge despite paired browser events', async () => {
    platformState.isMac = true;
    vi.resetModules();
    const { acquireWebglAddon } = await importReadyWebglPool();
    const terminal = createTerminal();
    const addon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(terminal),
      undefined,
      'focused',
    ) as unknown as MockWebglAddon;

    documentFocused = false;
    window.dispatchEvent(new Event('blur'));
    documentFocused = true;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(animationFrames.size).toBe(1);
    flushNextAnimationFrame();
    expect(addon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(terminal.refresh).toHaveBeenCalledTimes(1);
    expect(animationFrames.size).toBe(0);
  });

  it('does not automatically repair foreground transitions outside macOS', async () => {
    const { acquireWebglAddon } = await importReadyWebglPool();
    const terminal = createTerminal();
    const addon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(terminal),
      undefined,
      'focused',
    ) as unknown as MockWebglAddon;

    documentFocused = false;
    window.dispatchEvent(new Event('blur'));
    documentFocused = true;
    window.dispatchEvent(new Event('focus'));

    expect(animationFrames.size).toBe(0);
    expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it('repairs only a retained macOS entry when it becomes visible', async () => {
    platformState.isMac = true;
    vi.resetModules();
    const { acquireWebglAddon, setWebglAddonPriority } = await importReadyWebglPool();
    const retainedTerminal = createTerminal();
    const otherTerminal = createTerminal();
    const retainedAddon = acquireWebglAddon(
      getAgentId(0),
      asTerminal(retainedTerminal),
      undefined,
      'background',
    ) as unknown as MockWebglAddon;
    const otherAddon = acquireWebglAddon(
      getAgentId(1),
      asTerminal(otherTerminal),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;

    setWebglAddonPriority(getAgentId(0), 'visible');
    expect(animationFrames.size).toBe(1);
    flushNextAnimationFrame();

    expect(retainedAddon.clearTextureAtlas).toHaveBeenCalledTimes(1);
    expect(otherAddon.clearTextureAtlas).not.toHaveBeenCalled();

    const freshTerminal = createTerminal();
    const freshAddon = acquireWebglAddon(
      getAgentId(2),
      asTerminal(freshTerminal),
      undefined,
      'visible',
    ) as unknown as MockWebglAddon;
    expect(animationFrames.size).toBe(0);
    expect(freshAddon.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it('installs one listener set for the pool and removes it after the last release', async () => {
    const windowAddSpy = vi.spyOn(window, 'addEventListener');
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
    const documentAddSpy = vi.spyOn(document, 'addEventListener');
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener');
    const { acquireWebglAddon, releaseWebglAddon } = await importReadyWebglPool();

    acquireWebglAddon(getAgentId(0), asTerminal(createTerminal()));
    acquireWebglAddon(getAgentId(1), asTerminal(createTerminal()));

    expect(windowAddSpy.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1);
    expect(windowAddSpy.mock.calls.filter(([type]) => type === 'blur')).toHaveLength(1);
    expect(documentAddSpy.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(
      1,
    );

    releaseWebglAddon(getAgentId(0));
    expect(windowRemoveSpy).not.toHaveBeenCalled();
    releaseWebglAddon(getAgentId(1));

    expect(windowRemoveSpy.mock.calls.filter(([type]) => type === 'focus')).toHaveLength(1);
    expect(windowRemoveSpy.mock.calls.filter(([type]) => type === 'blur')).toHaveLength(1);
    expect(
      documentRemoveSpy.mock.calls.filter(([type]) => type === 'visibilitychange'),
    ).toHaveLength(1);
  });
});
