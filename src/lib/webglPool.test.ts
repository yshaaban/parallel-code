import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/addon-webgl', () => {
  class MockWebglAddon {
    private onContextLossCb: (() => void) | undefined;

    onContextLoss(cb: () => void): void {
      this.onContextLossCb = cb;
    }

    triggerContextLoss(): void {
      this.onContextLossCb?.();
    }

    dispose(): void {}
  }

  return { WebglAddon: MockWebglAddon };
});

type MockTerminal = {
  rows: number;
  loadAddon: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
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

  function getAgentId(index: number): string {
    return `${agentIdPrefix}-${index}`;
  }

  beforeEach(() => {
    agentIdPrefix = `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    vi.clearAllTimers();
    vi.clearAllMocks();
    vi.resetModules();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__: true,
      },
    });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    const { releaseWebglAddon } = await importReadyWebglPool();
    for (let i = 0; i < 8; i++) {
      releaseWebglAddon(getAgentId(i));
    }
    Reflect.deleteProperty(globalThis, 'window');
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
});
