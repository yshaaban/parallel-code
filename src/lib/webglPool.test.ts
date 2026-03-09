import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/addon-webgl', () => {
  class MockWebglAddon {
    private onContextLossCb: (() => void) | undefined;

    onContextLoss(cb: () => void): void {
      this.onContextLossCb = cb;
    }

    dispose(): void {
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

function createTerminal(): MockTerminal {
  return {
    rows: 24,
    loadAddon: vi.fn(),
    refresh: vi.fn(),
  };
}

describe('webglPool', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { releaseWebglAddon } = await import('./webglPool');
    for (let i = 0; i < 8; i++) {
      releaseWebglAddon(`agent-${i}`);
    }
  });

  it('touches active terminals so eviction is true LRU', async () => {
    const { acquireWebglAddon, touchWebglAddon } = await import('./webglPool');
    const terminals = Array.from({ length: 7 }, () => createTerminal());

    for (let i = 0; i < 6; i++) {
      acquireWebglAddon(`agent-${i}`, terminals[i] as never);
    }

    touchWebglAddon('agent-0');
    acquireWebglAddon('agent-6', terminals[6] as never);

    expect(terminals[0].refresh).not.toHaveBeenCalled();
    expect(terminals[1].refresh).toHaveBeenCalledTimes(1);
  });

  it('does not fire renderer-lost recovery during explicit release', async () => {
    const { acquireWebglAddon, releaseWebglAddon } = await import('./webglPool');
    const onRendererLost = vi.fn();

    acquireWebglAddon('agent-0', createTerminal() as never, onRendererLost);
    releaseWebglAddon('agent-0');
    await Promise.resolve();

    expect(onRendererLost).not.toHaveBeenCalled();
  });
});
