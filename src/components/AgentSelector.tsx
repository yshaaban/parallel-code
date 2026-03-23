import { For, Show, type JSX } from 'solid-js';
import { store } from '../store/store';
import { isHydraAgentDef } from '../lib/hydra';
import { SectionLabel } from './SectionLabel';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { AgentDef } from '../ipc/types';

interface AgentSelectorProps {
  agents: AgentDef[];
  selectedAgent: AgentDef | null;
  onSelect: (agent: AgentDef) => void;
}

function getAgentTextColor(isSelected: boolean): string {
  if (!isSelected) return theme.fg;
  if (store.themePreset === 'graphite' || store.themePreset === 'minimal') {
    return '#ffffff';
  }
  return theme.accentText;
}

function getAvailabilityLabel(agent: AgentDef): string | null {
  if (agent.available !== false) {
    if (agent.availabilitySource === 'bundled') {
      return 'bundled';
    }
    return null;
  }

  return 'unavailable';
}

export function AgentSelector(props: AgentSelectorProps): JSX.Element {
  return (
    <div data-nav-field="agent" style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <SectionLabel as="label">Agent</SectionLabel>
      <Show
        when={props.agents.length > 0}
        fallback={
          <div
            style={{
              padding: '10px 12px',
              background: theme.bgInput,
              border: `1px dashed ${theme.border}`,
              'border-radius': '8px',
              color: theme.fgMuted,
              ...typography.meta,
            }}
          >
            No agents detected. Check the server PATH or add a custom agent in Settings.
          </div>
        }
      >
        <div style={{ display: 'flex', gap: '8px' }}>
          <For each={props.agents}>
            {(agent) => {
              const isSelected = () => props.selectedAgent?.id === agent.id;
              return (
                <button
                  type="button"
                  class={`agent-btn ${isSelected() ? 'selected' : ''}`}
                  onClick={() => props.onSelect(agent)}
                  style={{
                    flex: '1',
                    padding: '10px 8px',
                    background: isSelected() ? theme.bgSelected : theme.bgInput,
                    border: isSelected()
                      ? `1px solid ${theme.accent}`
                      : `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    color: getAgentTextColor(isSelected()),
                    cursor: 'pointer',
                    ...(isSelected() ? typography.metaStrong : typography.meta),
                    'text-align': 'center',
                  }}
                  title={agent.availabilityReason}
                >
                  {agent.name}
                  <Show when={getAvailabilityLabel(agent)}>
                    <span
                      style={{
                        ...typography.label,
                        color: theme.fgMuted,
                        'margin-left': '4px',
                      }}
                    >
                      ({getAvailabilityLabel(agent)})
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        <Show when={props.selectedAgent}>
          {(agent) => (
            <div
              style={{
                padding: '10px 12px',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                color: theme.fgSubtle,
                ...typography.meta,
              }}
            >
              <div>{agent().description}</div>
              <Show when={isHydraAgentDef(agent())}>
                <div style={{ ...typography.meta, 'margin-top': '6px', color: theme.fgMuted }}>
                  {store.hydraForceDispatchFromPromptPanel
                    ? 'Prompt-panel messages are force-dispatched to Hydra. Type directly in the terminal for native Hydra chat and commands.'
                    : 'Prompt-panel messages are sent directly. Type in the terminal for native Hydra chat and commands.'}
                </div>
                <Show when={agent().availabilityReason}>
                  {(reason) => (
                    <div style={{ ...typography.meta, 'margin-top': '6px', color: theme.fgMuted }}>
                      {reason()}
                    </div>
                  )}
                </Show>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
