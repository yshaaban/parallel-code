import type { JSX } from 'solid-js';
import { theme } from '../../lib/theme';

interface AppErrorFallbackProps {
  error: unknown;
  onReset: () => void;
}

export function AppErrorFallback(props: AppErrorFallbackProps): JSX.Element {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '16px',
        background: theme.bg,
        color: theme.fg,
        'font-family': "var(--font-ui, 'Sora', sans-serif)",
      }}
    >
      <div style={{ 'font-size': '18px', 'font-weight': '600', color: theme.error }}>
        Something went wrong
      </div>
      <div
        style={{
          'max-width': '500px',
          'text-align': 'center',
          color: theme.fgMuted,
          'word-break': 'break-word',
        }}
      >
        {String(props.error)}
      </div>
      <button
        onClick={() => props.onReset()}
        style={{
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          color: theme.fg,
          padding: '8px 24px',
          'border-radius': '8px',
          cursor: 'pointer',
          'font-size': '14px',
        }}
      >
        Reload
      </button>
    </div>
  );
}
