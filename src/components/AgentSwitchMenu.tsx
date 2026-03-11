import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type { AgentDef } from '../ipc/types';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

interface AgentSwitchMenuProps {
  currentAgentDefId: string;
  availableAgents: AgentDef[];
  onRestartCurrent: () => void;
  onSelectAgent: (agentDef: AgentDef) => void;
}

export function AgentSwitchMenu(props: AgentSwitchMenuProps): JSX.Element {
  const [showMenu, setShowMenu] = createSignal(false);
  let menuRef: HTMLSpanElement | undefined;

  const handleClickOutside = (event: MouseEvent) => {
    if (menuRef && !menuRef.contains(event.target as Node)) {
      setShowMenu(false);
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
  });

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      ref={(element) => {
        menuRef = element;
      }}
    >
      <button
        onClick={(event) => {
          event.stopPropagation();
          props.onRestartCurrent();
        }}
        style={{
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          color: theme.fg,
          padding: '2px 8px',
          'border-radius': '4px 0 0 4px',
          'border-right': 'none',
          cursor: 'pointer',
          'font-size': sf(10),
        }}
      >
        Restart
      </button>
      <button
        onClick={(event) => {
          event.stopPropagation();
          setShowMenu(!showMenu());
        }}
        style={{
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          color: theme.fg,
          padding: '2px 4px',
          'border-radius': '0 4px 4px 0',
          cursor: 'pointer',
          'font-size': sf(10),
        }}
      >
        ▾
      </button>
      <Show when={showMenu()}>
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: '0',
            'margin-top': '4px',
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            padding: '4px 0',
            'z-index': '20',
            'min-width': '160px',
            'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          <div
            style={{
              padding: '4px 10px',
              'font-size': sf(9),
              color: theme.fgMuted,
            }}
          >
            Restart with…
          </div>
          <For each={props.availableAgents}>
            {(agentDef) => {
              const isCurrentAgent = () => agentDef.id === props.currentAgentDefId;

              return (
                <button
                  title={agentDef.description}
                  onClick={(event) => {
                    event.stopPropagation();
                    setShowMenu(false);
                    props.onSelectAgent(agentDef);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    background: isCurrentAgent() ? theme.bgSelected : 'transparent',
                    border: 'none',
                    color: theme.fg,
                    padding: '5px 10px',
                    cursor: 'pointer',
                    'font-size': sf(10),
                    'text-align': 'left',
                  }}
                  onMouseEnter={(event) => {
                    if (!isCurrentAgent()) {
                      event.currentTarget.style.background = theme.bgHover;
                    }
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = isCurrentAgent()
                      ? theme.bgSelected
                      : 'transparent';
                  }}
                >
                  {agentDef.name}
                  <Show when={isCurrentAgent()}>
                    {' '}
                    <span style={{ opacity: 0.5 }}>(current)</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </span>
  );
}
