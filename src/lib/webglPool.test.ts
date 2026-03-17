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
  });

  afterEach(async () => {
    vi.clearAllTimers();
    const { releaseWebglAddon } = await import('./webglPool');
    for (let i = 0; i < 8; i++) {
      releaseWebglAddon(getAgentId(i));
    }
  });

  it('touches active terminals so eviction is true LRU', async () => {
    const { acquireWebglAddon, touchWebglAddon } = await import('./webglPool');
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let i = 0; i < 6; i++) {
      acquireWebglAddon(getAgentId(i), terminals[i] as never);
    }

    touchWebglAddon(getAgentId(0));
    acquireWebglAddon(getAgentId(6), terminals[6] as never);

    expect(terminals[0].refresh).not.toHaveBeenCalled();
    expect(terminals[1].refresh).toHaveBeenCalledTimes(1);
  });

  it('does not fire renderer-lost recovery during explicit release', async () => {
    const { acquireWebglAddon, releaseWebglAddon } = await import('./webglPool');
    const onRendererLost = vi.fn();

    acquireWebglAddon(getAgentId(0), createTerminal() as never, onRendererLost);
    releaseWebglAddon(getAgentId(0));
    await Promise.resolve();

    expect(onRendererLost).not.toHaveBeenCalled();
  });

  it('refreshes the terminal and notifies recovery handlers on context loss', async () => {
    const { acquireWebglAddon } = await import('./webglPool');
    const term = createTerminal();
    const onRendererLost = vi.fn();

    const addon = acquireWebglAddon(getAgentId(0), term as never, onRendererLost) as {
      triggerContextLoss: () => void;
    } | null;

    expect(addon).not.toBeNull();
    addon?.triggerContextLoss();
    await Promise.resolve();

    expect(term.refresh).toHaveBeenCalledWith(0, term.rows - 1);
    expect(onRendererLost).toHaveBeenCalledTimes(1);

    const replacement = acquireWebglAddon(getAgentId(0), term as never, onRendererLost);
    expect(replacement).not.toBe(addon);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
  });
});
