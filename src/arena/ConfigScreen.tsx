import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';

import { IPC } from '../../electron/ipc/channels';
import { ProjectSelect } from '../components/ProjectSelect';
import type { ArenaCompetitorInspectIssue, ArenaCompetitorInspectResult } from '../ipc/types.js';
import { invoke } from '../lib/ipc';
import { getProject, store } from '../store/store';
import { saveArenaPresets } from './persistence';
import {
  MAX_COMPETITORS,
  MIN_COMPETITORS,
  addCompetitor,
  applyPreset,
  arenaStore,
  canFight,
  deletePreset,
  removeCompetitor,
  saveCurrentAsPreset,
  setCwd,
  setPhase,
  setPrompt,
  startBattle,
  updateCompetitor,
} from './store';
import type { ArenaCompetitor, BattleCompetitor } from './types';

const TOOL_PRESETS: Array<{ command: string; name: string }> = [
  { name: 'Claude', command: 'claude -p "{prompt}" --dangerously-skip-permissions' },
  { name: 'Codex', command: 'codex exec --full-auto "{prompt}"' },
  { name: 'Gemini', command: 'gemini -p "{prompt}" --yolo' },
  { name: 'Copilot', command: 'copilot -p "{prompt}" --yolo' },
  { name: 'Aider', command: 'aider -m "{prompt}" --yes' },
  { name: 'OpenCode', command: 'opencode -p "{prompt}"' },
];

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function isConfiguredCompetitor(competitor: ArenaCompetitor): boolean {
  return competitor.name.trim() !== '' && competitor.command.trim() !== '';
}

function getBlockingIssue(
  result: ArenaCompetitorInspectResult | undefined,
): ArenaCompetitorInspectIssue | undefined {
  return result?.issues.find((issue) => issue.severity === 'error');
}

function getWarningIssues(
  result: ArenaCompetitorInspectResult | undefined,
): ArenaCompetitorInspectIssue[] {
  return result?.issues.filter((issue) => issue.severity === 'warning') ?? [];
}

function getPreflightLabel(
  result: ArenaCompetitorInspectResult | undefined,
  checking: boolean,
): string | null {
  if (checking && result === undefined) {
    return 'Checking competitor availability…';
  }

  if (!result) {
    return null;
  }

  switch (result.status) {
    case 'ready':
      return getWarningIssues(result).length > 0 ? 'Ready with warning' : 'Ready';
    case 'missing_command':
      return 'Command unavailable';
    case 'missing_auth':
      return 'Authentication required';
    case 'unsupported_runtime':
      return 'Unsupported runtime';
    case 'invalid_command':
      return 'Invalid command';
    default:
      return null;
  }
}

function getCompetitorInspectResult(
  inspectResults: Record<string, ArenaCompetitorInspectResult>,
  competitorId: string,
): ArenaCompetitorInspectResult | undefined {
  return inspectResults[competitorId];
}

function hasReadyPreflightResult(
  inspectResults: Record<string, ArenaCompetitorInspectResult>,
  competitorId: string,
): boolean {
  return getCompetitorInspectResult(inspectResults, competitorId)?.status === 'ready';
}

export function ConfigScreen() {
  const [presetName, setPresetName] = createSignal('');
  const [showPresetSave, setShowPresetSave] = createSignal(false);
  const [preparing, setPreparing] = createSignal(false);
  const [fightError, setFightError] = createSignal<string | null>(null);
  const [inspectError, setInspectError] = createSignal<string | null>(null);
  const [inspecting, setInspecting] = createSignal(false);
  const [inspectResults, setInspectResults] = createSignal<
    Record<string, ArenaCompetitorInspectResult>
  >({});
  const filledCompetitors = createMemo(() => arenaStore.competitors.filter(isConfiguredCompetitor));
  const canStartFight = createMemo(() => {
    if (!canFight() || preparing() || inspecting()) {
      return false;
    }

    const currentInspectResults = inspectResults();
    return filledCompetitors().every((competitor) => {
      return hasReadyPreflightResult(currentInspectResults, competitor.id);
    });
  });

  let inspectGeneration = 0;

  createEffect(() => {
    const competitors = filledCompetitors().map((competitor) => ({
      command: competitor.command,
      id: competitor.id,
    }));
    const generation = ++inspectGeneration;

    if (competitors.length === 0) {
      setInspectResults({});
      setInspectError(null);
      setInspecting(false);
      return;
    }

    setInspecting(true);
    setInspectError(null);

    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const results = await Promise.all(
            competitors.map(async (competitor) => {
              const result = await invoke(IPC.InspectArenaCompetitor, {
                commandTemplate: competitor.command,
              });
              return [competitor.id, result] as const;
            }),
          );

          if (generation !== inspectGeneration) {
            return;
          }

          setInspectResults(Object.fromEntries(results));
        } catch (error) {
          if (generation !== inspectGeneration) {
            return;
          }

          setInspectResults({});
          setInspectError(error instanceof Error ? error.message : String(error));
        } finally {
          if (generation === inspectGeneration) {
            setInspecting(false);
          }
        }
      })();
    }, 150);

    onCleanup(() => window.clearTimeout(timeout));
  });

  async function handleFight() {
    if (!canStartFight()) return;
    setPreparing(true);
    setFightError(null);

    try {
      const projectRoot = arenaStore.cwd;
      const runId = Date.now();
      const competitorsToStart = filledCompetitors();
      const currentInspectResults = inspectResults();
      const competitors: BattleCompetitor[] = await Promise.all(
        competitorsToStart.map(async (competitor, index) => {
          const preflightResult = getCompetitorInspectResult(currentInspectResults, competitor.id);
          if (!preflightResult || preflightResult.status !== 'ready') {
            throw new Error('All arena competitors must pass preflight before starting.');
          }

          let worktreePath: string | null = null;
          let branchName: string | null = null;

          if (projectRoot) {
            branchName = `arena/${slug(competitor.name)}-${runId}-${index}`;
            const result = await invoke(IPC.CreateArenaWorktree, {
              branchName,
              projectRoot,
              symlinkDirs: ['node_modules'],
            });
            worktreePath = result.path;
          }

          return {
            agentId: crypto.randomUUID(),
            branchName,
            command: competitor.command,
            endTime: null,
            exitCode: null,
            id: competitor.id,
            name: competitor.name,
            preflightIssues: preflightResult.issues,
            startTime: Date.now(),
            status: 'running' as const,
            worktreePath,
          };
        }),
      );

      startBattle(competitors);
    } catch (error) {
      setFightError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }

  function handleToolPreset(tool: { command: string; name: string }) {
    const emptySlot = arenaStore.competitors.find(
      (competitor) => competitor.name.trim() === '' && competitor.command.trim() === '',
    );
    if (emptySlot) {
      updateCompetitor(emptySlot.id, { command: tool.command, name: tool.name });
      return;
    }

    if (arenaStore.competitors.length >= MAX_COMPETITORS) {
      return;
    }

    addCompetitor();
    const lastCompetitor = arenaStore.competitors[arenaStore.competitors.length - 1];
    updateCompetitor(lastCompetitor.id, { command: tool.command, name: tool.name });
  }

  function handleSavePreset() {
    const name = presetName().trim();
    if (!name) return;
    saveCurrentAsPreset(name);
    void saveArenaPresets();
    setPresetName('');
    setShowPresetSave(false);
  }

  function handleApplyPreset(preset: {
    competitors: Array<{ command: string; name: string }>;
    id: string;
    name: string;
  }) {
    applyPreset(preset);
  }

  function handleDeletePreset(id: string) {
    deletePreset(id);
    void saveArenaPresets();
  }

  return (
    <div class="arena-config">
      <span class="arena-section-label">Quick add</span>
      <div class="arena-tool-presets">
        <For each={TOOL_PRESETS}>
          {(tool) => (
            <button
              class="arena-tool-preset-btn"
              onClick={() => handleToolPreset(tool)}
              title={tool.command}
            >
              + {tool.name}
            </button>
          )}
        </For>
      </div>

      <span class="arena-section-label">Competitors</span>
      <div class="arena-competitors-grid">
        <For each={arenaStore.competitors}>
          {(competitor, index) => {
            const result = () => getCompetitorInspectResult(inspectResults(), competitor.id);
            const preflightLabel = () =>
              getPreflightLabel(result(), inspecting() && isConfiguredCompetitor(competitor));
            const blockingIssue = () => getBlockingIssue(result());
            const warningIssues = () => getWarningIssues(result());

            return (
              <div class="arena-competitor-card" data-arena={index()}>
                <div class="arena-competitor-card-header">
                  <span class="arena-competitor-card-number">Competitor {index() + 1}</span>
                  <button
                    class="arena-remove-btn"
                    disabled={arenaStore.competitors.length <= MIN_COMPETITORS}
                    onClick={() => removeCompetitor(competitor.id)}
                    title="Remove competitor"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                    </svg>
                  </button>
                </div>
                <input
                  class="arena-competitor-input"
                  type="text"
                  placeholder="Name (e.g. Claude, Codex, Gemini)"
                  value={competitor.name}
                  onInput={(event) =>
                    updateCompetitor(competitor.id, { name: event.currentTarget.value })
                  }
                />
                <input
                  class="arena-competitor-input arena-command-input"
                  type="text"
                  placeholder={
                    'Command — direct executable only; use {prompt} for the arena prompt'
                  }
                  value={competitor.command}
                  onInput={(event) =>
                    updateCompetitor(competitor.id, { command: event.currentTarget.value })
                  }
                />
                <div class="arena-competitor-command-note">
                  Use a direct executable invocation. Shell wrappers and environment prefixes are
                  rejected during preflight.
                </div>
                <Show when={preflightLabel()}>
                  {(label) => (
                    <div
                      class="arena-competitor-preflight"
                      data-status={result()?.status ?? 'checking'}
                    >
                      <div class="arena-competitor-preflight-state">{label()}</div>
                      <Show when={blockingIssue()}>
                        {(issue) => (
                          <div class="arena-competitor-preflight-issue" data-severity="error">
                            {issue().message}
                          </div>
                        )}
                      </Show>
                      <For each={warningIssues()}>
                        {(issue) => (
                          <div class="arena-competitor-preflight-issue" data-severity="warning">
                            {issue.message}
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={arenaStore.competitors.length < MAX_COMPETITORS}>
        <button class="arena-add-btn" onClick={() => addCompetitor()}>
          + Add Competitor
        </button>
      </Show>

      <span class="arena-section-label">Project</span>
      <ProjectSelect
        value={store.projects.find((project) => project.path === arenaStore.cwd)?.id ?? null}
        onChange={(id) => setCwd(id ? (getProject(id)?.path ?? '') : '')}
        placeholder="Select a project..."
      />

      <span class="arena-section-label">Prompt</span>
      <textarea
        class="arena-prompt-area"
        placeholder="Enter the coding task prompt that all competitors will receive..."
        value={arenaStore.prompt}
        onInput={(event) => setPrompt(event.currentTarget.value)}
      />

      <Show when={inspectError()}>
        <div class="arena-merge-error">{inspectError()}</div>
      </Show>
      <Show when={fightError()}>
        <div class="arena-merge-error">{fightError()}</div>
      </Show>

      <div class="arena-config-actions">
        <button class="arena-fight-btn" disabled={!canStartFight()} onClick={handleFight}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            style={{ 'margin-right': '6px' }}
          >
            <path d="M3 3L13 13M9 12L12 9" />
            <path d="M13 3L3 13M4 9L7 12" />
          </svg>
          Fight!
        </button>
      </div>

      <span class="arena-section-label">Saved presets</span>
      <Show when={arenaStore.presets.length > 0}>
        <For each={arenaStore.presets}>
          {(preset) => (
            <div class="arena-preset-row">
              <button class="arena-preset-btn" onClick={() => handleApplyPreset(preset)}>
                {preset.name}
              </button>
              <button
                class="arena-preset-delete-btn"
                onClick={() => handleDeletePreset(preset.id)}
                title="Delete preset"
              >
                x
              </button>
            </div>
          )}
        </For>
      </Show>

      <Show when={!showPresetSave()}>
        <button class="arena-add-btn" onClick={() => setShowPresetSave(true)}>
          Save current configuration as preset
        </button>
      </Show>

      <Show when={showPresetSave()}>
        <div class="arena-preset-row">
          <input
            class="arena-competitor-input"
            type="text"
            placeholder="Preset name"
            value={presetName()}
            onInput={(event) => setPresetName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSavePreset();
              if (event.key === 'Escape') {
                setShowPresetSave(false);
                setPresetName('');
              }
            }}
          />
          <button class="arena-preset-btn" onClick={handleSavePreset}>
            Save
          </button>
          <button
            class="arena-preset-delete-btn"
            onClick={() => {
              setShowPresetSave(false);
              setPresetName('');
            }}
          >
            Cancel
          </button>
        </div>
      </Show>

      <button class="arena-history-link" onClick={() => setPhase('history')}>
        View match history
      </button>
    </div>
  );
}
