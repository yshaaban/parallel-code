import { Show, createMemo, type JSX } from 'solid-js';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';
import { getTerminalStartupSummary } from '../store/terminal-startup';

export function TerminalStartupChip(): JSX.Element {
  const summary = createMemo(() => getTerminalStartupSummary());

  return (
    <Show when={summary()}>
      {(currentSummary) => (
        <div
          aria-live="polite"
          role="status"
          style={{
            position: 'absolute',
            right: '18px',
            bottom: '18px',
            'z-index': '1300',
            'pointer-events': 'none',
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            padding: '10px 12px',
            background: 'color-mix(in srgb, var(--island-bg) 88%, rgba(10, 13, 17, 0.22))',
            border: `1px solid ${theme.border}`,
            'border-radius': '12px',
            'box-shadow': '0 14px 32px rgba(0, 0, 0, 0.24)',
            color: theme.fg,
            'backdrop-filter': 'blur(6px)',
          }}
        >
          <span
            class="inline-spinner"
            aria-hidden="true"
            style={{ width: '12px', height: '12px' }}
          />
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '2px',
            }}
          >
            <span style={{ 'font-size': sf(12), 'font-weight': '600' }}>
              {currentSummary().label}
            </span>
            <Show when={currentSummary().detail}>
              {(detail) => (
                <span style={{ 'font-size': sf(10), color: theme.fgMuted }}>{detail()}</span>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
