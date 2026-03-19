import { Show, type JSX } from 'solid-js';
import { sf } from '../../lib/fontScale';
import { theme } from '../../lib/theme';

interface SidebarSectionHeaderProps {
  actions?: JSX.Element;
  collapsed: boolean;
  count?: string | number;
  label: string;
  onToggle: () => void;
}

function renderChevron(collapsed: boolean): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{
        transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
        transition: 'transform 120ms ease',
      }}
    >
      <path d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  );
}

export function SidebarSectionHeader(props: SidebarSectionHeaderProps): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        width: '100%',
      }}
    >
      <button
        type="button"
        onClick={() => props.onToggle()}
        aria-expanded={!props.collapsed}
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          gap: '10px',
          flex: '1',
          padding: '0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          'font-family': 'inherit',
          'text-align': 'left',
        }}
      >
        <span
          style={{
            'font-size': sf(10),
            color: theme.fgSubtle,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          {props.label}
        </span>
        <span
          style={{
            display: 'inline-flex',
            'align-items': 'center',
            gap: '8px',
            'flex-shrink': '0',
            color: theme.fgSubtle,
          }}
        >
          <Show when={props.count !== undefined}>
            <span
              aria-hidden="true"
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '999px',
                padding: '2px 8px',
                'font-size': sf(10),
                color: theme.fgMuted,
                'font-variant-numeric': 'tabular-nums',
              }}
            >
              {props.count}
            </span>
          </Show>
          <span aria-hidden="true">{renderChevron(props.collapsed)}</span>
        </span>
      </button>
      <Show when={props.actions}>{(actions) => actions()}</Show>
    </div>
  );
}
