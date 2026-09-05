import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';
import type { ISearchOptions, ISearchResultChangeEvent, SearchAddon } from '@xterm/addon-search';

import {
  getTerminalSearchDecorationTheme,
  type TerminalSearchDecorationTheme,
} from '../../lib/theme';
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  TERMINAL_SEARCH_QUERY_LIMIT,
  type TerminalSearchResult,
} from '../../lib/terminal-search';

export {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  TERMINAL_SEARCH_QUERY_LIMIT,
  type TerminalSearchResult,
} from '../../lib/terminal-search';

export interface TerminalSearchCapability {
  clear(): void;
  close(): void;
  find(query: string, options: { direction: 'next' | 'previous'; incremental: boolean }): void;
  getSelectionSeed(): string;
  setDecorationTheme(theme: TerminalSearchDecorationTheme): void;
}

export interface TerminalSearchRuntime extends TerminalSearchCapability {
  dispose(): void;
}

type SearchAddonConstructor = new (options?: { highlightLimit?: number }) => SearchAddon;

interface TerminalSearchRuntimeOptions {
  cancelFrame?: (handle: number) => void;
  loadAddonConstructor?: () => Promise<SearchAddonConstructor>;
  onResult: (result: TerminalSearchResult) => void;
  onUnavailable: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  term: Pick<Terminal, 'getSelection' | 'loadAddon'>;
  warn?: () => void;
}

interface SearchRequest {
  direction: 'next' | 'previous';
  incremental: boolean;
  query: string;
}

const EMPTY_SEARCH_RESULT: TerminalSearchResult = { count: 0, index: -1 };
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

let cachedSearchAddonConstructor: SearchAddonConstructor | undefined;
let searchAddonConstructorPromise: Promise<SearchAddonConstructor> | undefined;

function loadTerminalSearchAddonConstructor(): Promise<SearchAddonConstructor> {
  if (cachedSearchAddonConstructor) {
    return Promise.resolve(cachedSearchAddonConstructor);
  }

  if (!searchAddonConstructorPromise) {
    searchAddonConstructorPromise = import('@xterm/addon-search')
      .then((module) => {
        cachedSearchAddonConstructor = module.SearchAddon;
        return module.SearchAddon;
      })
      .catch((error: unknown) => {
        searchAddonConstructorPromise = undefined;
        throw error;
      });
  }

  return searchAddonConstructorPromise;
}

function requestSearchFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(callback);
  }

  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelSearchFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
    return;
  }

  window.clearTimeout(handle);
}

function normalizeSearchResult(result: ISearchResultChangeEvent): TerminalSearchResult {
  const rawCount = Number.isFinite(result.resultCount) ? Math.trunc(result.resultCount) : 0;
  const count = Math.min(TERMINAL_SEARCH_HIGHLIGHT_LIMIT, Math.max(0, rawCount));
  const rawIndex = Number.isFinite(result.resultIndex) ? Math.trunc(result.resultIndex) : -1;
  const index = rawIndex >= 0 && rawIndex < count ? rawIndex : -1;

  return { count, index };
}

function sanitizeDecorationTheme(
  theme: TerminalSearchDecorationTheme,
): TerminalSearchDecorationTheme {
  return Object.values(theme).every((color) => HEX_COLOR_PATTERN.test(color))
    ? theme
    : getTerminalSearchDecorationTheme('classic');
}

function getSearchOptions(
  request: SearchRequest,
  decorations: TerminalSearchDecorationTheme,
): ISearchOptions {
  return {
    caseSensitive: false,
    decorations,
    incremental: request.incremental,
    regex: false,
    wholeWord: false,
  };
}

export function createTerminalSearchRuntime(
  options: TerminalSearchRuntimeOptions,
): TerminalSearchRuntime {
  const loadAddonConstructor = options.loadAddonConstructor ?? loadTerminalSearchAddonConstructor;
  const requestFrame = options.requestFrame ?? requestSearchFrame;
  const cancelFrame = options.cancelFrame ?? cancelSearchFrame;
  const warn =
    options.warn ?? (() => console.warn('[terminal-search] Search addon is unavailable'));

  let addon: SearchAddon | undefined;
  let resultSubscription: IDisposable | undefined;
  let scheduledFrame: number | undefined;
  let lifecycleGeneration = 0;
  let disposed = false;
  let failedForOpen = false;
  let loadPending = false;
  let latestQuery = '';
  let executedQuery = '';
  let pendingIncremental: SearchRequest | undefined;
  let pendingNavigation: 'next' | 'previous' | undefined;
  let decorationTheme = getTerminalSearchDecorationTheme('classic');
  let lastResult = EMPTY_SEARCH_RESULT;

  function emitResult(result: TerminalSearchResult, force = false): void {
    if (!force && lastResult.count === result.count && lastResult.index === result.index) {
      return;
    }

    lastResult = result;
    options.onResult(result);
  }

  function cancelScheduledFrame(): void {
    if (scheduledFrame === undefined) {
      return;
    }

    cancelFrame(scheduledFrame);
    scheduledFrame = undefined;
  }

  function releaseAddon(): void {
    cancelScheduledFrame();
    pendingIncremental = undefined;
    pendingNavigation = undefined;

    const currentAddon = addon;
    addon = undefined;
    resultSubscription?.dispose();
    resultSubscription = undefined;

    if (!currentAddon) {
      return;
    }

    try {
      currentAddon.clearDecorations();
    } catch {
      // Search cleanup is cosmetic and must never block terminal teardown.
    }
    try {
      currentAddon.dispose();
    } catch {
      // An optional addon cannot make terminal teardown fail.
    }
  }

  function failOpenAttempt(): void {
    if (disposed || failedForOpen) {
      return;
    }

    failedForOpen = true;
    loadPending = false;
    releaseAddon();
    emitResult(EMPTY_SEARCH_RESULT);
    warn();
    options.onUnavailable();
  }

  function executeSearch(request: SearchRequest): void {
    const currentAddon = addon;
    if (!currentAddon || disposed || failedForOpen) {
      return;
    }

    try {
      const searchOptions = getSearchOptions(request, decorationTheme);
      if (request.direction === 'previous') {
        currentAddon.findPrevious(request.query, searchOptions);
      } else {
        currentAddon.findNext(request.query, searchOptions);
      }
      executedQuery = request.query;
    } catch {
      failOpenAttempt();
    }
  }

  function drainPendingWork(): void {
    scheduledFrame = undefined;
    if (!addon || disposed || failedForOpen) {
      return;
    }

    const incremental = pendingIncremental;
    pendingIncremental = undefined;
    if (incremental) {
      executeSearch(incremental);
    }

    const navigation = pendingNavigation;
    pendingNavigation = undefined;
    if (navigation && latestQuery.length > 0 && addon && !failedForOpen) {
      executeSearch({ direction: navigation, incremental: false, query: latestQuery });
    }
  }

  function schedulePendingWork(): void {
    if (scheduledFrame !== undefined || !addon || disposed || failedForOpen) {
      return;
    }

    scheduledFrame = requestFrame(drainPendingWork);
  }

  function attachAddon(SearchAddonConstructor: SearchAddonConstructor, generation: number): void {
    if (disposed || generation !== lifecycleGeneration || failedForOpen || addon) {
      return;
    }

    let nextAddon: SearchAddon | undefined;
    try {
      nextAddon = new SearchAddonConstructor({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT });
      options.term.loadAddon(nextAddon as ITerminalAddon);
      const attachedAddon = nextAddon;
      resultSubscription = attachedAddon.onDidChangeResults((result) => {
        if (
          disposed ||
          generation !== lifecycleGeneration ||
          addon !== attachedAddon ||
          failedForOpen
        ) {
          return;
        }

        // Every addon event completes a concrete query/navigation request. The
        // numeric result can legitimately be unchanged, while presentation is
        // waiting for this exact completion to leave its loading state.
        emitResult(normalizeSearchResult(result), true);
      });
      addon = attachedAddon;
      schedulePendingWork();
    } catch {
      nextAddon?.dispose();
      failOpenAttempt();
    }
  }

  function ensureAddon(): void {
    if (addon || loadPending || failedForOpen || disposed) {
      return;
    }

    loadPending = true;
    const generation = lifecycleGeneration;
    void loadAddonConstructor()
      .then((SearchAddonConstructor) => {
        loadPending = false;
        attachAddon(SearchAddonConstructor, generation);
      })
      .catch(() => {
        loadPending = false;
        if (!disposed && generation === lifecycleGeneration) {
          failOpenAttempt();
        }
      });
  }

  function clear(): void {
    latestQuery = '';
    executedQuery = '';
    pendingIncremental = undefined;
    pendingNavigation = undefined;
    cancelScheduledFrame();
    try {
      addon?.clearDecorations();
    } catch {
      failOpenAttempt();
      return;
    }
    emitResult(EMPTY_SEARCH_RESULT);
  }

  function close(): void {
    lifecycleGeneration += 1;
    loadPending = false;
    failedForOpen = false;
    latestQuery = '';
    executedQuery = '';
    releaseAddon();
    emitResult(EMPTY_SEARCH_RESULT);
  }

  return {
    clear,
    close,
    dispose(): void {
      if (disposed) {
        return;
      }

      close();
      disposed = true;
    },
    find(query, searchOptions): void {
      if (disposed || failedForOpen) {
        return;
      }

      const boundedQuery = query.slice(0, TERMINAL_SEARCH_QUERY_LIMIT);
      if (boundedQuery.length === 0) {
        clear();
        return;
      }

      const queryChanged = latestQuery !== boundedQuery;
      latestQuery = boundedQuery;
      if (searchOptions.incremental) {
        pendingIncremental = {
          direction: searchOptions.direction,
          incremental: true,
          query: boundedQuery,
        };
        pendingNavigation = undefined;
      } else {
        if (queryChanged || executedQuery !== boundedQuery) {
          pendingIncremental = {
            direction: 'next',
            incremental: true,
            query: boundedQuery,
          };
        }
        pendingNavigation = searchOptions.direction;
      }

      ensureAddon();
      if (!addon) {
        return;
      }

      if (!searchOptions.incremental) {
        cancelScheduledFrame();
        drainPendingWork();
        return;
      }

      schedulePendingWork();
    },
    getSelectionSeed(): string {
      const selection = options.term.getSelection();
      if (
        selection.length === 0 ||
        selection.length > TERMINAL_SEARCH_QUERY_LIMIT ||
        /[\r\n]/u.test(selection)
      ) {
        return '';
      }

      return selection;
    },
    setDecorationTheme(theme): void {
      decorationTheme = sanitizeDecorationTheme(theme);
      if (disposed || failedForOpen || latestQuery.length === 0 || !addon) {
        return;
      }

      pendingIncremental = {
        direction: 'next',
        incremental: true,
        query: latestQuery,
      };
      pendingNavigation = undefined;
      schedulePendingWork();
    },
  };
}
