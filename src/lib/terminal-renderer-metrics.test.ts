import { describe, expect, it, vi } from 'vitest';

import { alignTerminalDomRendererWidthMetricsWithWebgl } from './terminal-renderer-metrics';

function createDomRendererLike(): {
  renderer: {
    __parallelCodeDomWidthPatched?: boolean;
    _bufferService: { cols: number };
    _charSizeService: { width: number };
    _coreBrowserService: { dpr: number };
    _optionsService: { rawOptions: { letterSpacing: number } };
    _rowElements: Array<{ style: { width: string } }>;
    _rowFactory: { defaultSpacing: number };
    _screenElement: { style: { width: string } };
    _setDefaultSpacing: ReturnType<typeof vi.fn>;
    _updateDimensions: ReturnType<typeof vi.fn>;
    _widthCache: { clear: ReturnType<typeof vi.fn> };
    dimensions: {
      css: { canvas: { width: number }; cell: { width: number } };
      device: {
        canvas: { width: number };
        cell: { width: number };
        char: { width: number };
      };
    };
  };
  updateDimensionsMock: ReturnType<typeof vi.fn>;
} {
  const renderer = {
    _bufferService: { cols: 80 },
    _charSizeService: { width: 7.3 },
    _coreBrowserService: { dpr: 1.25 },
    _optionsService: { rawOptions: { letterSpacing: 0 } },
    _rowElements: [{ style: { width: '' } }, { style: { width: '' } }],
    _rowFactory: { defaultSpacing: 0 },
    _screenElement: { style: { width: '' } },
    _setDefaultSpacing: vi.fn(),
    _updateDimensions: vi.fn(function setDomWidthMath(this: {
      dimensions: {
        css: { canvas: { width: number }; cell: { width: number } };
        device: {
          canvas: { width: number };
          cell: { width: number };
          char: { width: number };
        };
      };
    }) {
      this.dimensions.device.char.width = 9.125;
      this.dimensions.device.cell.width = 9.125;
      this.dimensions.device.canvas.width = 730;
      this.dimensions.css.canvas.width = 584;
      this.dimensions.css.cell.width = 7.3;
    }),
    _widthCache: { clear: vi.fn() },
    dimensions: {
      css: { canvas: { width: 0 }, cell: { width: 0 } },
      device: {
        canvas: { width: 0 },
        cell: { width: 0 },
        char: { width: 0 },
      },
    },
  };

  return {
    renderer,
    updateDimensionsMock: renderer._updateDimensions,
  };
}

describe('alignTerminalDomRendererWidthMetricsWithWebgl', () => {
  it('patches the active DOM renderer to use WebGL-aligned width math', () => {
    const { renderer } = createDomRendererLike();
    const term = {
      _core: {
        _createRenderer: vi.fn(() => renderer),
        _renderService: {
          _renderer: renderer,
        },
      },
    };

    alignTerminalDomRendererWidthMetricsWithWebgl(term as never);

    expect(renderer.dimensions.device.char.width).toBe(9);
    expect(renderer.dimensions.device.cell.width).toBe(9);
    expect(renderer.dimensions.device.canvas.width).toBe(720);
    expect(renderer.dimensions.css.canvas.width).toBe(576);
    expect(renderer.dimensions.css.cell.width).toBeCloseTo(7.2, 5);
    expect(renderer._screenElement.style.width).toBe('576px');
    expect(renderer._rowElements[0]?.style.width).toBe('576px');
    expect(renderer._widthCache.clear).toHaveBeenCalledTimes(1);
    expect(renderer._setDefaultSpacing).toHaveBeenCalledTimes(1);
  });

  it('patches future DOM fallback renderers created by xterm core', () => {
    const { renderer } = createDomRendererLike();
    const createRendererMock = vi.fn(() => renderer);
    const term = {
      _core: {
        _createRenderer: createRendererMock,
        _renderService: {
          _renderer: null,
        },
      },
    };

    alignTerminalDomRendererWidthMetricsWithWebgl(term as never);
    const nextRenderer = term._core._createRenderer?.();

    expect(createRendererMock).toHaveBeenCalledTimes(1);
    expect(nextRenderer).toBe(renderer);
    expect(renderer.dimensions.css.cell.width).toBeCloseTo(7.2, 5);
    expect(renderer._widthCache.clear).toHaveBeenCalledTimes(1);
    expect(renderer._setDefaultSpacing).toHaveBeenCalledTimes(1);
  });
});
