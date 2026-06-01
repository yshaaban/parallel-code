import { For, Show, createSignal, type JSX } from 'solid-js';
import { getAgentResumeStrategy } from '../lib/agent-resume';
import { parseDirectCommandLine } from '../lib/direct-command';
import { createRandomId } from '../lib/random-id';
import { addCustomAgent, removeCustomAgent } from '../app/agent-catalog';
import { store } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

export function CustomAgentEditor(): JSX.Element {
  const [showForm, setShowForm] = createSignal(false);
  const [name, setName] = createSignal('');
  const [command, setCommand] = createSignal('');
  const [resumeArgs, setResumeArgs] = createSignal('');
  const [skipArgs, setSkipArgs] = createSignal('');
  const [error, setError] = createSignal('');

  function updateName(value: string): void {
    setName(value);
    setError('');
  }

  function updateCommand(value: string): void {
    setCommand(value);
    setError('');
  }

  function trimmedName(): string {
    return name().trim();
  }

  function trimmedCommand(): string {
    return command().trim();
  }

  function canAddAgent(): boolean {
    return trimmedName().length > 0 && trimmedCommand().length > 0;
  }

  function splitOptionalArgs(value: string): string[] {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  }

  function getCustomAgentId(agentName: string): string {
    const slug = agentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const suffix = createRandomId().slice(0, 8);
    return slug ? `custom-${slug}-${suffix}` : `custom-agent-${suffix}`;
  }

  function handleAdd(): void {
    const n = trimmedName();
    const cmd = trimmedCommand();
    if (!n || !cmd) return;
    const parsed = parseDirectCommandLine(cmd);
    if (!parsed.ok) {
      setError(parsed.error.message);
      return;
    }

    const agent: AgentDef = {
      id: getCustomAgentId(n),
      name: n,
      command: parsed.invocation.command,
      args: parsed.invocation.args,
      ...(parsed.invocation.env !== undefined ? { env: parsed.invocation.env } : {}),
      resume_args: splitOptionalArgs(resumeArgs()),
      skip_permissions_args: splitOptionalArgs(skipArgs()),
      description: `Custom agent: ${n}`,
    };
    agent.resume_strategy = getAgentResumeStrategy(agent);
    addCustomAgent(agent);
    setName('');
    setCommand('');
    setResumeArgs('');
    setSkipArgs('');
    setError('');
    setShowForm(false);
  }

  function inputStyle(): JSX.CSSProperties {
    return {
      padding: '8px 10px',
      background: theme.bgInput,
      border: `1px solid ${theme.border}`,
      'border-radius': '6px',
      color: theme.fg,
      'font-size': '12px',
      width: '100%',
      'box-sizing': 'border-box' as const,
    };
  }

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
      <For each={store.customAgents}>
        {(agent) => (
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              padding: '8px 12px',
              'border-radius': '8px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
            }}
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
              <span style={{ 'font-size': '13px', color: theme.fg }}>{agent.name}</span>
              <span
                style={{
                  'font-size': '11px',
                  color: theme.fgSubtle,
                  'font-family': "'JetBrains Mono', monospace",
                }}
              >
                {[agent.command, ...agent.args].join(' ')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => removeCustomAgent(agent.id)}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '16px',
                padding: '0 4px',
              }}
            >
              &times;
            </button>
          </div>
        )}
      </For>

      <Show when={!showForm()}>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          style={{
            padding: '8px 12px',
            background: 'transparent',
            border: `1px dashed ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '12px',
          }}
        >
          + Add custom agent
        </button>
      </Show>

      <Show when={showForm()}>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            padding: '12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="text"
            placeholder="Name (e.g. OpenCode)"
            value={name()}
            onInput={(e) => updateName(e.currentTarget.value)}
            style={inputStyle()}
          />
          <input
            type="text"
            placeholder="Command (e.g. opencode)"
            value={command()}
            onInput={(e) => updateCommand(e.currentTarget.value)}
            style={inputStyle()}
          />
          <Show when={error()}>
            <div style={{ color: theme.error, 'font-size': '12px' }}>{error()}</div>
          </Show>
          <input
            type="text"
            placeholder="Resume args (optional, space-separated)"
            value={resumeArgs()}
            onInput={(e) => setResumeArgs(e.currentTarget.value)}
            style={inputStyle()}
          />
          <input
            type="text"
            placeholder="Skip permissions args (optional, space-separated)"
            value={skipArgs()}
            onInput={(e) => setSkipArgs(e.currentTarget.value)}
            style={inputStyle()}
          />
          <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              style={{
                padding: '6px 14px',
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '12px',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canAddAgent()}
              onClick={handleAdd}
              style={{
                padding: '6px 14px',
                background: theme.accent,
                border: 'none',
                'border-radius': '6px',
                color: '#fff',
                cursor: canAddAgent() ? 'pointer' : 'not-allowed',
                'font-size': '12px',
                opacity: canAddAgent() ? 1 : 0.5,
              }}
            >
              Add Agent
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
