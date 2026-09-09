import { performance } from 'node:perf_hooks';

import type { Terminal } from '@xterm/xterm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { atlasGroups } = vi.hoisted(() => ({
  atlasGroups: { count: 6, next: 0, canvases: Array.from({ length: 6 }, () => ({})) },
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    private index = atlasGroups.next++;
    get textureAtlas(): object | undefined {
      return atlasGroups.canvases[this.index % atlasGroups.count];
    }
    clearTextureAtlas(): void {}
    dispose(): void {}
    onContextLoss(): void {}
  },
}));

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Infinity;
}

describe('WebGL atlas repair benchmark', () => {
  const animationFrames: FrameRequestCallback[] = [];
  const terminals = Array.from({ length: 6 }, () => ({
    loadAddon: vi.fn(),
    refresh: vi.fn(),
    rows: 24,
  }));

  beforeAll(async () => {
    const fakeWindow = new EventTarget() as EventTarget & {
      __PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__?: boolean;
    };
    fakeWindow.__PARALLEL_CODE_RENDERER_RUNTIME_DIAGNOSTICS__ = true;
    const fakeDocument = new EventTarget();
    Object.defineProperties(fakeDocument, {
      hasFocus: { configurable: true, value: () => true },
      visibilityState: { configurable: true, value: 'visible' },
    });
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const { acquireWebglAddon, preloadWebglAddon } = await import('./webglPool.js');
    await preloadWebglAddon();
    for (let index = 0; index < terminals.length; index += 1) {
      acquireWebglAddon(
        `benchmark-${index}`,
        terminals[index] as unknown as Terminal,
        undefined,
        index === 0 ? 'focused' : 'visible',
      );
    }
  });

  afterAll(async () => {
    const { releaseWebglAddon } = await import('./webglPool.js');
    for (let index = 0; index < terminals.length; index += 1) {
      releaseWebglAddon(`benchmark-${index}`);
    }
    vi.unstubAllGlobals();
  });

  it.each([1, 3, 6])(
    'keeps six-surface repair bounded with %i shared atlases',
    async (groupCount) => {
      atlasGroups.count = groupCount;
      const { requestVisibleWebglAtlasRepair } = await import('./webglPool.js');
      const queueDurations: number[] = [];
      const frameDurations: number[] = [];

      for (let iteration = 0; iteration < 500; iteration += 1) {
        const queueStartedAt = performance.now();
        expect(requestVisibleWebglAtlasRepair('manual')).toBe(6);
        queueDurations.push(performance.now() - queueStartedAt);

        let drainedFrames = 0;
        while (animationFrames.length > 0) {
          const callback = animationFrames.shift();
          if (!callback) {
            break;
          }
          const frameStartedAt = performance.now();
          callback(performance.now());
          frameDurations.push(performance.now() - frameStartedAt);
          drainedFrames += 1;
        }
        expect(drainedFrames).toBe(groupCount);
      }

      expect(percentile(queueDurations, 0.95)).toBeLessThanOrEqual(2);
      expect(percentile(frameDurations, 0.95)).toBeLessThanOrEqual(2);
      expect(Math.max(...frameDurations)).toBeLessThan(50);
      process.stdout.write(
        `${JSON.stringify({ groupCount, queueP95Ms: percentile(queueDurations, 0.95), frameP95Ms: percentile(frameDurations, 0.95) })}\n`,
      );
    },
  );
});
