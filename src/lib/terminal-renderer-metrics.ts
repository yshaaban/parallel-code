import type { Terminal } from '@xterm/xterm';

interface CoreBrowserServiceLike {
  dpr: number;
}

interface CharSizeServiceLike {
  width: number;
}

interface BufferServiceLike {
  cols: number;
}

interface OptionsServiceLike {
  rawOptions: {
    letterSpacing: number;
  };
}

interface RenderDimensionsLike {
  css: {
    canvas: {
      width: number;
    };
    cell: {
      width: number;
    };
  };
  device: {
    canvas: {
      width: number;
    };
    cell: {
      width: number;
    };
    char: {
      width: number;
    };
  };
}

interface WidthCacheLike {
  clear(): void;
}

interface RowFactoryLike {
  defaultSpacing: number;
}

interface DomRendererLike {
  __parallelCodeDomWidthPatched?: boolean;
  _bufferService: BufferServiceLike;
  _charSizeService: CharSizeServiceLike;
  _coreBrowserService: CoreBrowserServiceLike;
  _optionsService: OptionsServiceLike;
  _rowElements: Array<HTMLElement>;
  _rowFactory: RowFactoryLike;
  _screenElement: HTMLElement;
  _setDefaultSpacing(): void;
  _updateDimensions(): void;
  _widthCache: WidthCacheLike;
  dimensions: RenderDimensionsLike;
}

interface CoreLike {
  __parallelCodeCreateRendererWidthPatchApplied?: boolean;
  _createRenderer?: () => unknown;
  _renderService?: {
    _renderer?: unknown;
  };
}

const DOM_RENDERER_WIDTH_PATCH_MARKER = '__parallelCodeDomWidthPatched';
const CREATE_RENDERER_WIDTH_PATCH_MARKER = '__parallelCodeCreateRendererWidthPatchApplied';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDomRendererLike(renderer: unknown): renderer is DomRendererLike {
  return (
    isObject(renderer) &&
    typeof renderer._updateDimensions === 'function' &&
    typeof renderer._setDefaultSpacing === 'function' &&
    Array.isArray(renderer._rowElements) &&
    isObject(renderer._widthCache) &&
    typeof renderer._widthCache.clear === 'function' &&
    isObject(renderer._rowFactory) &&
    isObject(renderer._bufferService) &&
    isObject(renderer._charSizeService) &&
    isObject(renderer._coreBrowserService) &&
    isObject(renderer._optionsService) &&
    isObject(renderer.dimensions)
  );
}

function getAlignedDomRendererWidthMetrics(renderer: DomRendererLike): {
  cssCanvasWidth: number;
  cssCellWidth: number;
  deviceCanvasWidth: number;
  deviceCellWidth: number;
  deviceCharWidth: number;
} | null {
  const dpr = renderer._coreBrowserService.dpr;
  const charWidth = renderer._charSizeService.width;
  const cols = renderer._bufferService.cols;
  const letterSpacing = renderer._optionsService.rawOptions.letterSpacing;

  if (
    !Number.isFinite(dpr) ||
    dpr <= 0 ||
    !Number.isFinite(charWidth) ||
    charWidth <= 0 ||
    !Number.isFinite(cols) ||
    cols <= 0 ||
    !Number.isFinite(letterSpacing)
  ) {
    return null;
  }

  const deviceCharWidth = Math.floor(charWidth * dpr);
  const deviceCellWidth = deviceCharWidth + Math.round(letterSpacing);
  const deviceCanvasWidth = cols * deviceCellWidth;
  const cssCanvasWidth = Math.round(deviceCanvasWidth / dpr);
  const cssCellWidth = deviceCellWidth / dpr;

  return {
    cssCanvasWidth,
    cssCellWidth,
    deviceCanvasWidth,
    deviceCellWidth,
    deviceCharWidth,
  };
}

function applyAlignedDomRendererWidthMetrics(renderer: DomRendererLike): void {
  const metrics = getAlignedDomRendererWidthMetrics(renderer);
  if (!metrics) {
    return;
  }

  renderer.dimensions.device.char.width = metrics.deviceCharWidth;
  renderer.dimensions.device.cell.width = metrics.deviceCellWidth;
  renderer.dimensions.device.canvas.width = metrics.deviceCanvasWidth;
  renderer.dimensions.css.canvas.width = metrics.cssCanvasWidth;
  renderer.dimensions.css.cell.width = metrics.cssCellWidth;

  for (const rowElement of renderer._rowElements) {
    rowElement.style.width = `${metrics.cssCanvasWidth}px`;
  }
  renderer._screenElement.style.width = `${metrics.cssCanvasWidth}px`;
}

function patchDomRendererWidthMetrics(renderer: unknown): void {
  if (!isDomRendererLike(renderer) || renderer[DOM_RENDERER_WIDTH_PATCH_MARKER] === true) {
    return;
  }

  const originalUpdateDimensions = renderer._updateDimensions.bind(renderer);
  renderer._updateDimensions = function patchedUpdateDimensions(): void {
    originalUpdateDimensions();
    applyAlignedDomRendererWidthMetrics(renderer);
  };
  renderer[DOM_RENDERER_WIDTH_PATCH_MARKER] = true;
  applyAlignedDomRendererWidthMetrics(renderer);
  renderer._widthCache.clear();
  renderer._setDefaultSpacing();
}

function patchFutureDomRenderers(core: CoreLike): void {
  if (
    core[CREATE_RENDERER_WIDTH_PATCH_MARKER] === true ||
    typeof core._createRenderer !== 'function'
  ) {
    return;
  }

  const originalCreateRenderer = core._createRenderer.bind(core);
  core._createRenderer = function createRendererWithAlignedDomWidths(): unknown {
    const renderer = originalCreateRenderer();
    patchDomRendererWidthMetrics(renderer);
    return renderer;
  };
  core[CREATE_RENDERER_WIDTH_PATCH_MARKER] = true;
}

export function alignTerminalDomRendererWidthMetricsWithWebgl(term: Terminal): void {
  const core = (term as Terminal & { _core?: CoreLike })._core;
  if (!core) {
    return;
  }

  patchFutureDomRenderers(core);
  patchDomRendererWidthMetrics(core._renderService?._renderer);
}
