import { Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';

import type { AskAboutCodeSession } from '../app/task-ai-workflows';
import type { AskAboutCodeMessage } from '../domain/ask-about-code';
import { assertNever } from '../lib/assert-never';
import { buildAskAboutCodePrompt } from '../lib/review-prompts';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';

const MAX_RESPONSE_LENGTH = 100_000;

interface AskCodeCardProps {
  endLine: number;
  onDismiss: () => void;
  question: string;
  requestId: string;
  selectedText: string;
  source: string;
  startLine: number;
  startSession: (
    requestId: string,
    prompt: string,
    cwd: string,
    onMessage: (message: AskAboutCodeMessage) => void,
  ) => Promise<AskAboutCodeSession>;
  worktreePath: string;
}

function appendResponseChunk(previous: string, text: string): string {
  if (previous.length >= MAX_RESPONSE_LENGTH) {
    return previous;
  }

  const next = previous + text;
  if (next.length >= MAX_RESPONSE_LENGTH) {
    return `${next.slice(0, MAX_RESPONSE_LENGTH)}\n\n[Response truncated]`;
  }

  return next;
}

export function AskCodeCard(props: AskCodeCardProps): JSX.Element {
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [response, setResponse] = createSignal('');
  let cleanupAfterAttach = false;
  let disposed = false;
  let session: AskAboutCodeSession | undefined;

  function handleMessage(message: AskAboutCodeMessage): void {
    switch (message.type) {
      case 'chunk':
        setResponse((previous) => appendResponseChunk(previous, message.text ?? ''));
        return;
      case 'error':
        setError((previous) => previous + (message.text ?? ''));
        return;
      case 'done':
        cleanupAfterAttach = true;
        session?.cleanup();
        session = undefined;
        setLoading(false);
        return;
      default:
        assertNever(message.type, 'Unhandled ask-about-code message type');
    }
  }

  async function cancel(): Promise<void> {
    const activeSession = session;
    session = undefined;
    if (!activeSession) {
      return;
    }

    await activeSession.cancel().catch(() => {});
  }

  async function dismiss(): Promise<void> {
    await cancel();
    props.onDismiss();
  }

  onMount(() => {
    const prompt = buildAskAboutCodePrompt(
      props.source,
      props.startLine,
      props.endLine,
      props.selectedText,
      props.question,
    );

    props
      .startSession(props.requestId, prompt, props.worktreePath, handleMessage)
      .then((nextSession) => {
        if (disposed || cleanupAfterAttach) {
          void nextSession.cancel();
          return;
        }

        session = nextSession;
      })
      .catch((nextError: unknown) => {
        if (disposed) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setLoading(false);
      });
  });

  onCleanup(() => {
    disposed = true;
    void cancel();
  });

  return (
    <div
      style={{
        margin: '4px 40px 4px 80px',
        border: `1px solid ${theme.border}`,
        'border-left': `3px solid ${theme.accent}`,
        'border-radius': '4px',
        background: theme.bgElevated,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '4px 10px',
          'border-bottom': `1px solid ${theme.borderSubtle}`,
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <span
          style={{
            'font-size': sf(11),
            color: theme.fgMuted,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          Q: {props.question}
        </span>
        <button
          onClick={() => {
            void dismiss();
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '2px 4px',
            'border-radius': '3px',
            'font-size': sf(14),
            'line-height': '1',
          }}
          title="Dismiss"
        >
          ×
        </button>
      </div>

      <div
        style={{
          padding: '8px 12px',
          'font-size': sf(12),
          'font-family': "'JetBrains Mono', monospace",
          'line-height': '1.5',
          color: theme.fg,
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
          'max-height': '300px',
          'overflow-y': 'auto',
        }}
      >
        <Show when={loading() && !response()}>
          <span
            style={{
              color: theme.fgSubtle,
              animation: 'askcode-pulse 1.5s ease-in-out infinite',
            }}
          >
            Thinking...
          </span>
        </Show>
        <Show when={response()}>{response()}</Show>
        <Show when={loading() && response()}>
          <span
            style={{
              color: theme.accent,
              'font-size': sf(10),
              animation: 'askcode-pulse 1s ease-in-out infinite',
            }}
          >
            {' '}
            ●
          </span>
        </Show>
        <Show when={error()}>
          <div style={{ color: theme.error, 'margin-top': '4px' }}>{error()}</div>
        </Show>
      </div>
    </div>
  );
}
