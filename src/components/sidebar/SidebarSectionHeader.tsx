import { Show, type JSX } from 'solid-js';
import { SectionLabel } from '../SectionLabel';
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
        gap: 'var(--space-2xs)',
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
          gap: 'var(--space-xs)',
          flex: '1',
          padding: '0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          'font-family': 'inherit',
          'text-align': 'left',
        }}
      >
        <SectionLabel as="span" tone="subtle">
          {props.label}
        </SectionLabel>
        <span
          style={{
            display: 'inline-flex',
            'align-items': 'center',
            gap: 'var(--space-2xs)',
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
                padding: '1px var(--space-2xs)',
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
