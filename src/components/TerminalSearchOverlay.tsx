import { createEffect, onMount, type JSX } from 'solid-js';

import { isMac } from '../lib/platform';
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  TERMINAL_SEARCH_QUERY_LIMIT,
  type TerminalSearchResult,
} from '../lib/terminal-search';
import { isPrimaryTerminalFindShortcut } from '../lib/terminal-shortcuts';

interface TerminalSearchOverlayProps {
  focusVersion: number;
  loading: boolean;
  onClose: () => void;
  onNavigate: (direction: 'next' | 'previous') => void;
  onQueryChange: (query: string) => void;
  query: string;
  result: TerminalSearchResult;
  unavailable: boolean;
}

export function getTerminalSearchResultLabel(
  query: string,
  result: TerminalSearchResult,
  options: { loading: boolean; unavailable: boolean },
): string {
  if (options.unavailable) {
    return 'Search unavailable';
  }
  if (query.length === 0) {
    return '';
  }
  if (options.loading) {
    return 'Searching…';
  }
  if (result.count === 0) {
    return 'No results';
  }
  if (result.count >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT) {
    return `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT.toLocaleString('en-US')} matches (display limit)`;
  }
  if (result.index < 0) {
    return `${result.count.toLocaleString('en-US')} ${result.count === 1 ? 'match' : 'matches'}`;
  }

  return `${(result.index + 1).toLocaleString('en-US')}/${result.count.toLocaleString('en-US')}`;
}

export function TerminalSearchOverlay(props: TerminalSearchOverlayProps): JSX.Element {
  let inputRef!: HTMLInputElement;

  function focusAndSelectInput(): void {
    inputRef.focus();
    inputRef.select();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }

    if (isPrimaryTerminalFindShortcut(event, isMac)) {
      event.preventDefault();
      event.stopPropagation();
      focusAndSelectInput();
      return;
    }

    if (
      event.target === inputRef &&
      event.key === 'Enter' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      props.onNavigate(event.shiftKey ? 'previous' : 'next');
    }
  }

  onMount(focusAndSelectInput);
  createEffect(() => {
    void props.focusVersion;
    queueMicrotask(focusAndSelectInput);
  });

  const resultLabel = () =>
    getTerminalSearchResultLabel(props.query, props.result, {
      loading: props.loading,
      unavailable: props.unavailable,
    });

  return (
    <div
      role="search"
      class="terminal-search-overlay"
      data-terminal-search-overlay="true"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        aria-label="Find in terminal"
        class="terminal-search-input"
        maxLength={TERMINAL_SEARCH_QUERY_LIMIT}
        type="text"
        value={props.query}
        onInput={(event) =>
          props.onQueryChange(event.currentTarget.value.slice(0, TERMINAL_SEARCH_QUERY_LIMIT))
        }
      />
      <span
        role="status"
        aria-live="polite"
        class="terminal-search-status"
        data-terminal-search-result={resultLabel() || undefined}
        data-terminal-search-unavailable={props.unavailable ? 'true' : undefined}
      >
        {resultLabel()}
      </span>
      <button
        type="button"
        aria-label="Previous terminal match"
        class="terminal-search-button"
        disabled={props.query.length === 0 || props.unavailable}
        title="Previous match (Shift+Enter)"
        onClick={() => props.onNavigate('previous')}
        onMouseDown={(event) => event.preventDefault()}
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        aria-label="Next terminal match"
        class="terminal-search-button"
        disabled={props.query.length === 0 || props.unavailable}
        title="Next match (Enter)"
        onClick={() => props.onNavigate('next')}
        onMouseDown={(event) => event.preventDefault()}
      >
        <span aria-hidden="true">↓</span>
      </button>
      <button
        type="button"
        aria-label="Close terminal search"
        class="terminal-search-button"
        title="Close search (Escape)"
        onClick={() => props.onClose()}
        onMouseDown={(event) => event.preventDefault()}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
