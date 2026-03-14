import { createSignal, onMount, type JSX } from 'solid-js';

import type { ReviewInteractionMode } from '../app/review-session';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';

interface InlineInputProps {
  onDismiss: () => void;
  onSubmit: (text: string, mode: ReviewInteractionMode) => void;
}

export function InlineInput(props: InlineInputProps): JSX.Element {
  const [mode, setMode] = createSignal<ReviewInteractionMode>('review');
  const [text, setText] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    requestAnimationFrame(() => inputRef?.focus());
  });

  function getBorderColor(): string {
    return mode() === 'review' ? theme.warning : theme.accent;
  }

  function getPlaceholder(): string {
    return mode() === 'review' ? 'Add review comment...' : 'Ask about this code...';
  }

  function submit(): void {
    const trimmedText = text().trim();
    if (!trimmedText) {
      return;
    }

    props.onSubmit(trimmedText, mode());
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === 'Escape') {
      props.onDismiss();
    }
  }

  return (
    <div
      onMouseUp={(event) => event.stopPropagation()}
      style={{
        margin: '4px 40px 4px 80px',
        'max-width': '560px',
        display: 'flex',
        gap: '4px',
        padding: '4px',
        background: theme.bgElevated,
        border: `1px solid ${theme.border}`,
        'border-left': `3px solid ${getBorderColor()}`,
        'border-radius': '4px',
      }}
    >
      <div
        style={{
          display: 'flex',
          'border-radius': '3px',
          overflow: 'hidden',
          border: `1px solid ${theme.borderSubtle}`,
          'flex-shrink': '0',
          'align-self': 'center',
        }}
      >
        <button
          onClick={() => setMode('review')}
          style={{
            background: mode() === 'review' ? theme.warning : 'transparent',
            color: mode() === 'review' ? theme.accentText : theme.fgMuted,
            border: 'none',
            'font-size': sf(10),
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          Comment
        </button>
        <button
          onClick={() => setMode('ask')}
          style={{
            background: mode() === 'ask' ? theme.accent : 'transparent',
            color: mode() === 'ask' ? theme.accentText : theme.fgMuted,
            border: 'none',
            'font-size': sf(10),
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          Ask
        </button>
      </div>

      <input
        ref={inputRef}
        type="text"
        placeholder={getPlaceholder()}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        style={{
          flex: '1',
          background: theme.bgInput,
          border: `1px solid ${theme.borderSubtle}`,
          'border-radius': '4px',
          color: theme.fg,
          'font-size': sf(12),
          'font-family': "'JetBrains Mono', monospace",
          padding: '4px 8px',
          outline: 'none',
        }}
      />

      <button
        onClick={submit}
        disabled={!text().trim()}
        style={{
          background: text().trim() ? getBorderColor() : 'transparent',
          border: `1px solid ${text().trim() ? getBorderColor() : theme.borderSubtle}`,
          color: text().trim() ? theme.accentText : theme.fgMuted,
          cursor: text().trim() ? 'pointer' : 'default',
          padding: '4px 10px',
          'border-radius': '4px',
          'font-size': sf(11),
          'font-weight': '600',
        }}
      >
        {mode() === 'review' ? 'Comment' : 'Ask'}
      </button>
    </div>
  );
}
