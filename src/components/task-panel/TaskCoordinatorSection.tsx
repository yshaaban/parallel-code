import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
  type JSX,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import { callCoordinatorUiTool } from '../../app/coordinator';
import {
  createCoordinatorRunView,
  getCoordinatorSubtaskActions,
  type CoordinatorAttentionLevel,
  type CoordinatorSubtaskChipView,
  type CoordinatorUiAction,
  type CoordinatorUiActionId,
  type CoordinatorWorkflowTimelineView,
} from '../../app/coordinator-ui-model';
import type {
  CoordinatorSpawnSubtaskPayload,
  CoordinatorUiToolCallRequest,
} from '../../domain/coordinator';
import { parseDirectCommandLine, type DirectCommandInvocation } from '../../lib/direct-command';
import { sf } from '../../lib/fontScale';
import { getRuntimeClientId } from '../../lib/runtime-client-id';
import { theme } from '../../lib/theme';
import { getCoordinatorRunForTask } from '../../store/coordinator';
import type { Task } from '../../store/types';
import type { PanelChild } from '../ResizablePanel';
import { ScalablePanel } from '../ScalablePanel';

interface TaskCoordinatorSectionProps {
  task: Accessor<Task>;
}

type PeekTab = 'diff' | 'meta' | 'tail';

interface CoordinatorOutputResult {
  output: string;
  truncatedBytes: number;
}

interface CoordinatorDiffFile {
  added?: number;
  additions?: number;
  path?: string;
  removed?: number;
  deletions?: number;
  status?: string;
}

interface CoordinatorDiffResult {
  files: CoordinatorDiffFile[];
  patch?: string;
  totalAdded: number;
  totalRemoved: number;
  truncatedBytes: number;
}

type CoordinatorSpawnPayloadParseResult =
  | {
      ok: true;
      payload: CoordinatorSpawnSubtaskPayload;
    }
  | {
      error: string;
      ok: false;
    };

const TONE_COLOR: Record<CoordinatorAttentionLevel, string> = {
  danger: theme.error,
  info: theme.accent,
  normal: theme.fgSubtle,
  success: theme.success,
  warning: theme.warning,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOutputResult(value: unknown): CoordinatorOutputResult | null {
  if (!isRecord(value) || typeof value.output !== 'string') {
    return null;
  }

  return {
    output: value.output,
    truncatedBytes: typeof value.truncatedBytes === 'number' ? value.truncatedBytes : 0,
  };
}

function asDiffResult(value: unknown): CoordinatorDiffResult | null {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return null;
  }

  return {
    files: value.files.filter(isRecord).map((file) => ({
      added: typeof file.added === 'number' ? file.added : undefined,
      additions: typeof file.additions === 'number' ? file.additions : undefined,
      deletions: typeof file.deletions === 'number' ? file.deletions : undefined,
      path: typeof file.path === 'string' ? file.path : undefined,
      removed: typeof file.removed === 'number' ? file.removed : undefined,
      status: typeof file.status === 'string' ? file.status : undefined,
    })),
    patch: typeof value.patch === 'string' ? value.patch : undefined,
    totalAdded: typeof value.totalAdded === 'number' ? value.totalAdded : 0,
    totalRemoved: typeof value.totalRemoved === 'number' ? value.totalRemoved : 0,
    truncatedBytes: typeof value.truncatedBytes === 'number' ? value.truncatedBytes : 0,
  };
}

function toneColor(tone: CoordinatorAttentionLevel): string {
  return TONE_COLOR[tone];
}

function createToolRequest(
  action: CoordinatorUiAction,
  chip: CoordinatorSubtaskChipView,
  coordinatorTaskId: string,
  runId: string,
  text: string,
): CoordinatorUiToolCallRequest | null {
  const base = {
    controllerId: getRuntimeClientId(),
    coordinatorTaskId,
    requestId: createRequestId(),
    runId,
  };

  switch (action.id) {
    case 'ask-land':
      return {
        ...base,
        payload: {
          kind: 'follow-up',
          targetTaskId: chip.taskId,
          text: [
            'Please land this subtask now.',
            'Commit any remaining work, run the relevant verification, then call land_self with a concise summary and verification list.',
          ].join('\n'),
        },
        toolName: 'send_prompt',
      };
    case 'close':
      return {
        ...base,
        payload: { targetTaskId: chip.taskId },
        toolName: 'close_task',
      };
    case 'inspect-diff':
      return {
        ...base,
        payload: {
          includePatch: true,
          maxBytes: 20_000,
          targetTaskId: chip.taskId,
        },
        toolName: 'get_task_diff',
      };
    case 'inspect-output':
      return {
        ...base,
        payload: {
          maxBytes: 12_000,
          targetTaskId: chip.taskId,
        },
        toolName: 'get_task_output',
      };
    case 'send-prompt':
      return {
        ...base,
        payload: {
          kind: 'follow-up',
          targetTaskId: chip.taskId,
          text,
        },
        toolName: 'send_prompt',
      };
    case 'wait-for-idle':
      return {
        ...base,
        payload: {
          targetTaskId: chip.taskId,
          timeoutMs: 15_000,
        },
        toolName: 'wait_for_idle',
      };
    case 'copy-debug-command':
    case 'spawn-subtask':
      return null;
  }
}

function toCoordinatorSpawnAgent(
  invocation: DirectCommandInvocation,
): CoordinatorSpawnSubtaskPayload['agent'] {
  const agent: CoordinatorSpawnSubtaskPayload['agent'] = {
    command: invocation.command,
  };

  if (invocation.args.length > 0) {
    agent.args = invocation.args;
  }
  if (invocation.env !== undefined) {
    agent.env = invocation.env;
  }

  return agent;
}

function parseCoordinatorSpawnPayload(
  name: string,
  assignment: string,
  commandLine: string,
): CoordinatorSpawnPayloadParseResult {
  const parsed = parseDirectCommandLine(commandLine);
  if (!parsed.ok) {
    return {
      error: parsed.error.message,
      ok: false,
    };
  }

  return {
    ok: true,
    payload: {
      agent: toCoordinatorSpawnAgent(parsed.invocation),
      assignment,
      name,
    },
  };
}

function createRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getDiffFilePath(file: CoordinatorDiffFile): string {
  return file.path ?? '(unknown file)';
}

function getDiffFileAdded(file: CoordinatorDiffFile): number {
  return file.added ?? file.additions ?? 0;
}

function getDiffFileRemoved(file: CoordinatorDiffFile): number {
  return file.removed ?? file.deletions ?? 0;
}

function getPeekTabLabel(tab: PeekTab): string {
  switch (tab) {
    case 'diff':
      return 'Diff';
    case 'meta':
      return 'Meta';
    case 'tail':
      return 'Tail';
  }
}

function findAction(
  actions: readonly CoordinatorUiAction[],
  id: CoordinatorUiActionId,
): CoordinatorUiAction | undefined {
  return actions.find((action) => action.id === id);
}

function getWorkflowLabel(workflow: CoordinatorWorkflowTimelineView): string {
  switch (workflow.template) {
    case 'adversarial_review':
      return 'Review';
    case 'custom':
      return 'Flow';
    case 'map_reduce':
      return 'Map';
  }
}

function getPopoverStyle(anchor: DOMRect | null): JSX.CSSProperties {
  const preferredTop = anchor ? anchor.bottom + 6 : 96;
  const top = Math.max(8, Math.min(preferredTop, window.innerHeight - 420));
  const left = anchor ? Math.max(8, Math.min(anchor.left, window.innerWidth - 390)) : 16;
  return {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    width: '380px',
    'max-width': 'calc(100vw - 16px)',
    'z-index': '70',
  };
}

export function TaskCoordinatorSection(props: TaskCoordinatorSectionProps): JSX.Element {
  let popoverRef: HTMLDivElement | undefined;
  let lastTriggerRef: HTMLButtonElement | undefined;

  const [selectedTaskId, setSelectedTaskId] = createSignal<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = createSignal<string | null>(null);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  const [tab, setTab] = createSignal<PeekTab>('tail');
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [actionStatus, setActionStatus] = createSignal<string | null>(null);
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [closeConfirmTaskId, setCloseConfirmTaskId] = createSignal<string | null>(null);
  const [diffResult, setDiffResult] = createSignal<CoordinatorDiffResult | null>(null);
  const [followUpText, setFollowUpText] = createSignal('');
  const [outputResult, setOutputResult] = createSignal<CoordinatorOutputResult | null>(null);
  const [showDebug, setShowDebug] = createSignal(false);
  const [showSpawn, setShowSpawn] = createSignal(false);
  const [spawnAssignment, setSpawnAssignment] = createSignal('');
  const [spawnCommand, setSpawnCommand] = createSignal('codex');
  const [spawnName, setSpawnName] = createSignal('');

  const run = createMemo(() => getCoordinatorRunForTask(props.task().id));
  const runView = createMemo(() => {
    const snapshot = run();
    if (!snapshot) {
      return null;
    }

    return createCoordinatorRunView(snapshot, {
      debugCommand: props.task().coordinatorToolCommand,
    });
  });
  const selectedChip = createMemo(() => {
    const view = runView();
    const taskId = selectedTaskId();
    if (!view || !taskId) {
      return null;
    }

    return view.chips.find((chip) => chip.taskId === taskId) ?? null;
  });
  const selectedWorkflow = createMemo(() => {
    const view = runView();
    const workflowId = selectedWorkflowId();
    if (!view || !workflowId) {
      return null;
    }

    return view.workflows.find((workflow) => workflow.id === workflowId) ?? null;
  });

  createEffect(() => {
    const view = runView();
    const selected = selectedTaskId();
    if (!view || !selected) {
      setSelectedTaskId(null);
      return;
    }

    if (view.chips.some((chip) => chip.taskId === selected)) {
      return;
    }

    setSelectedTaskId(null);
  });

  createEffect(() => {
    const view = runView();
    const selected = selectedWorkflowId();
    if (!view || !selected) {
      setSelectedWorkflowId(null);
      return;
    }

    if (view.workflows.some((workflow) => workflow.id === selected)) {
      return;
    }

    setSelectedWorkflowId(null);
  });

  createEffect(() => {
    selectedTaskId();
    selectedWorkflowId();
    setActionError(null);
    setActionStatus(null);
    setCloseConfirmTaskId(null);
    setDiffResult(null);
    setFollowUpText('');
    setOutputResult(null);
    setTab('tail');
  });

  function closePopover(): void {
    setSelectedTaskId(null);
    setSelectedWorkflowId(null);
    setAnchor(null);
    setShowDebug(false);
    setShowSpawn(false);
    queueMicrotask(() => lastTriggerRef?.focus());
  }

  function resetTransientState(): void {
    setActionError(null);
    setActionStatus(null);
    setCloseConfirmTaskId(null);
  }

  function openChip(event: MouseEvent, chip: CoordinatorSubtaskChipView): void {
    event.stopPropagation();
    lastTriggerRef = event.currentTarget as HTMLButtonElement;
    resetTransientState();
    setSelectedTaskId(chip.taskId);
    setSelectedWorkflowId(null);
    setAnchor((event.currentTarget as HTMLElement).getBoundingClientRect());
    setShowDebug(false);
    setShowSpawn(false);
  }

  function openWorkflow(event: MouseEvent, workflow: CoordinatorWorkflowTimelineView): void {
    event.stopPropagation();
    lastTriggerRef = event.currentTarget as HTMLButtonElement;
    resetTransientState();
    setSelectedWorkflowId(workflow.id);
    setSelectedTaskId(null);
    setAnchor((event.currentTarget as HTMLElement).getBoundingClientRect());
    setShowDebug(false);
    setShowSpawn(false);
  }

  function openSpawn(event: MouseEvent): void {
    event.stopPropagation();
    lastTriggerRef = event.currentTarget as HTMLButtonElement;
    resetTransientState();
    setAnchor((event.currentTarget as HTMLElement).getBoundingClientRect());
    setSelectedTaskId(null);
    setSelectedWorkflowId(null);
    setShowDebug(false);
    setShowSpawn(true);
  }

  function openDebug(event: MouseEvent): void {
    event.stopPropagation();
    lastTriggerRef = event.currentTarget as HTMLButtonElement;
    resetTransientState();
    setAnchor((event.currentTarget as HTMLElement).getBoundingClientRect());
    setSelectedTaskId(null);
    setSelectedWorkflowId(null);
    setShowSpawn(false);
    setShowDebug(true);
  }

  function getCurrentRunId(): string | null {
    return runView()?.run.id ?? null;
  }

  async function runToolAction(
    action: CoordinatorUiAction,
    chip: CoordinatorSubtaskChipView,
  ): Promise<void> {
    const view = runView();
    const runId = getCurrentRunId();
    if (!view || !runId || !action.toolName || action.disabled) {
      return;
    }

    if (action.id === 'send-prompt' && followUpText().trim().length === 0) {
      setActionError('Enter follow-up text first.');
      return;
    }
    if (action.id === 'close' && closeConfirmTaskId() !== chip.taskId) {
      setCloseConfirmTaskId(chip.taskId);
      setActionStatus('Click Close subtask again to confirm.');
      return;
    }

    setBusyAction(action.id);
    setActionError(null);
    setActionStatus(null);
    try {
      const request = createToolRequest(
        action,
        chip,
        view.run.coordinatorTaskId,
        runId,
        followUpText().trim(),
      );
      if (!request) {
        return;
      }

      const response = await callCoordinatorUiTool(request);
      if (!response.accepted) {
        throw new Error(response.error ?? 'Coordinator action was rejected.');
      }

      if (action.id === 'inspect-output') {
        setOutputResult(asOutputResult(response.result));
        setTab('tail');
        return;
      }
      if (action.id === 'inspect-diff') {
        setDiffResult(asDiffResult(response.result));
        setTab('diff');
        return;
      }
      if (action.id === 'send-prompt' || action.id === 'ask-land') {
        setFollowUpText('');
        setActionStatus(action.id === 'ask-land' ? 'Landing request queued.' : 'Prompt queued.');
        return;
      }
      if (action.id === 'wait-for-idle') {
        setActionStatus('Idle check finished.');
        return;
      }
      if (action.id === 'close') {
        setActionStatus('Subtask close requested.');
        setCloseConfirmTaskId(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function spawnSubtask(): Promise<void> {
    const view = runView();
    const name = spawnName().trim();
    const assignment = spawnAssignment().trim();
    const command = spawnCommand().trim();
    if (!view || view.spawnAction.disabled) {
      return;
    }
    if (!name || !assignment || !command) {
      setActionError('Name, assignment, and command are required.');
      return;
    }
    const spawnPayload = parseCoordinatorSpawnPayload(name, assignment, command);
    if (!spawnPayload.ok) {
      setActionError(spawnPayload.error);
      return;
    }

    setBusyAction('spawn-subtask');
    setActionError(null);
    try {
      const response = await callCoordinatorUiTool({
        coordinatorTaskId: view.run.coordinatorTaskId,
        controllerId: getRuntimeClientId(),
        payload: spawnPayload.payload,
        requestId: createRequestId(),
        runId: view.run.id,
        toolName: 'spawn_subtask',
      });
      if (!response.accepted) {
        throw new Error(response.error ?? 'Spawn was rejected.');
      }

      setSpawnAssignment('');
      setSpawnName('');
      setActionStatus('Subtask queued.');
      setShowSpawn(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function copyDebugCommand(): Promise<void> {
    const command = runView()?.debugCommand?.trim() || '$PARALLEL_CODE_COORDINATOR_TOOL';
    const text = `${command} list_tasks`;
    if (!navigator.clipboard) {
      setActionError('Clipboard is unavailable.');
      setActionStatus(null);
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setActionError(null);
      setActionStatus('Copied list_tasks command.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setActionStatus(null);
    }
  }

  createEffect(() => {
    if (!selectedChip() && !selectedWorkflow() && !showSpawn() && !showDebug()) {
      return;
    }

    function handleMouseDown(event: MouseEvent): void {
      const target = event.target;
      if (target instanceof Node && popoverRef?.contains(target)) {
        return;
      }

      closePopover();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') {
        return;
      }

      event.stopPropagation();
      closePopover();
    }

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown, true);
    onCleanup(() => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    });
  });

  return (
    <ScalablePanel panelId={`${props.task().id}:coordinator`}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
          padding: '6px 8px',
          background: theme.taskPanelBg,
          color: theme.fg,
          overflow: 'hidden',
        }}
      >
        <Show
          when={runView()}
          fallback={
            <div style={{ color: theme.fgSubtle, 'font-size': sf(11) }}>
              Coordinator starting...
            </div>
          }
        >
          {(view) => (
            <>
              <div
                title={view().summary.statusLabel}
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '5px',
                  'font-size': sf(11),
                  color: theme.fgMuted,
                  'white-space': 'nowrap',
                  'flex-shrink': '0',
                }}
              >
                <span style={{ color: toneColor(view().summary.runTone), 'font-weight': 700 }}>
                  {view().summary.runStatus === 'running' ? 'RUN' : view().summary.statusLabel}
                </span>
                <span>{`${view().summary.activeCount}/${view().summary.subtaskLimit}`}</span>
                <Show when={view().summary.pendingPromptCount > 0}>
                  <span
                    style={{ color: theme.accent }}
                  >{`Q${view().summary.pendingPromptCount}`}</span>
                </Show>
                <Show when={view().summary.attentionCount > 0}>
                  <span
                    style={{ color: theme.warning }}
                  >{`!${view().summary.attentionCount}`}</span>
                </Show>
              </div>

              <Show when={view().workflows.length > 0}>
                <div
                  aria-label="Coordinator workflows"
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '4px',
                    overflow: 'auto hidden',
                    'max-width': '38%',
                    'min-width': '120px',
                    'scrollbar-width': 'none',
                    'flex-shrink': '1',
                  }}
                >
                  <For each={view().workflows}>
                    {(workflow) => (
                      <button
                        aria-label={`Open workflow ${workflow.title}`}
                        onClick={(event) => openWorkflow(event, workflow)}
                        title={`${workflow.title}: ${workflow.statusLabel}`}
                        style={{
                          display: 'inline-flex',
                          'align-items': 'center',
                          gap: '5px',
                          height: '24px',
                          'min-width': '0',
                          padding: '0 7px',
                          border: `1px solid color-mix(in srgb, ${toneColor(workflow.tone)} 38%, ${theme.border})`,
                          'border-radius': '8px',
                          background: `color-mix(in srgb, ${toneColor(workflow.tone)} 7%, transparent)`,
                          color: theme.fgMuted,
                          cursor: 'pointer',
                          'font-size': sf(11),
                          'line-height': '1',
                          'white-space': 'nowrap',
                          'flex-shrink': '0',
                        }}
                      >
                        <span style={{ color: toneColor(workflow.tone), 'font-weight': 700 }}>
                          {getWorkflowLabel(workflow)}
                        </span>
                        <span>{workflow.resultCount}</span>
                        <Show when={workflow.findingCount > 0}>
                          <span
                            style={{ color: theme.warning }}
                          >{`!${workflow.findingCount}`}</span>
                        </Show>
                        <Show when={workflow.appendCount > 0}>
                          <span style={{ color: theme.accent }}>{`+${workflow.appendCount}`}</span>
                        </Show>
                        <For each={workflow.stages}>
                          {(stage) => (
                            <span
                              title={stage.title}
                              style={{
                                display: 'inline-flex',
                                'align-items': 'center',
                                'justify-content': 'center',
                                width: '14px',
                                height: '14px',
                                border: `1px solid ${toneColor(stage.tone)}`,
                                'border-radius': '999px',
                                color: toneColor(stage.tone),
                                'font-size': sf(9),
                                'font-weight': 700,
                              }}
                            >
                              {stage.label}
                            </span>
                          )}
                        </For>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <div
                aria-label="Coordinator subtasks"
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '4px',
                  overflow: 'auto hidden',
                  flex: '1 1 auto',
                  'min-width': '0',
                  'scrollbar-width': 'none',
                }}
              >
                <Show
                  when={!view().empty}
                  fallback={
                    <span style={{ color: theme.fgSubtle, 'font-size': sf(11) }}>No subtasks</span>
                  }
                >
                  <For each={view().chips}>
                    {(chip) => (
                      <button
                        aria-label={`Open ${chip.assignment}`}
                        title={chip.title}
                        onClick={(event) => openChip(event, chip)}
                        style={{
                          display: 'inline-flex',
                          'align-items': 'center',
                          gap: '4px',
                          height: '24px',
                          'min-width': '28px',
                          'max-width': '124px',
                          padding: '0 7px',
                          border: `1px solid color-mix(in srgb, ${toneColor(chip.tone)} 42%, ${theme.border})`,
                          'border-radius': '8px',
                          background:
                            selectedTaskId() === chip.taskId
                              ? `color-mix(in srgb, ${toneColor(chip.tone)} 18%, transparent)`
                              : `color-mix(in srgb, ${toneColor(chip.tone)} 8%, transparent)`,
                          color: theme.fg,
                          cursor: 'pointer',
                          'font-size': sf(11),
                          'line-height': '1',
                          overflow: 'hidden',
                          'white-space': 'nowrap',
                          'flex-shrink': '0',
                        }}
                      >
                        <span style={{ color: toneColor(chip.tone), 'font-weight': 700 }}>
                          {chip.label}
                        </span>
                        <Show when={chip.badgeText}>
                          {(badge) => (
                            <span style={{ color: theme.fgMuted, 'font-size': sf(10) }}>
                              {badge()}
                            </span>
                          )}
                        </Show>
                        <For each={chip.promptBeads}>
                          {(bead) => (
                            <span title={bead.title} style={{ color: toneColor(bead.tone) }}>
                              {bead.label}
                            </span>
                          )}
                        </For>
                      </button>
                    )}
                  </For>
                </Show>
              </div>

              <button
                aria-label="Spawn coordinator subtask"
                disabled={view().spawnAction.disabled}
                title={view().spawnAction.reason ?? 'Spawn coordinator subtask'}
                onClick={openSpawn}
                style={{
                  height: '24px',
                  width: '26px',
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  background: 'transparent',
                  color: view().spawnAction.disabled ? theme.fgSubtle : theme.accent,
                  cursor: view().spawnAction.disabled ? 'not-allowed' : 'pointer',
                  'flex-shrink': '0',
                }}
              >
                +
              </button>
              <button
                aria-label="Coordinator debug actions"
                title="Coordinator debug actions"
                onClick={openDebug}
                style={{
                  height: '24px',
                  width: '26px',
                  border: `1px solid ${theme.border}`,
                  'border-radius': '8px',
                  background: 'transparent',
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  'flex-shrink': '0',
                }}
              >
                ⋯
              </button>
            </>
          )}
        </Show>
      </div>
      <Show when={selectedChip() || selectedWorkflow() || showSpawn() || showDebug()}>
        <Portal>
          <div
            ref={(element) => {
              popoverRef = element;
            }}
            role="dialog"
            aria-label="Coordinator controls"
            style={{
              ...getPopoverStyle(anchor()),
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fg,
              padding: '10px',
              display: 'flex',
              'flex-direction': 'column',
              gap: '8px',
              'max-height': 'calc(100vh - 16px)',
              overflow: 'auto',
              'box-shadow': '0 8px 18px rgba(0,0,0,0.26)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <Show when={selectedWorkflow()}>
              {(workflow) => (
                <>
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'space-between',
                      gap: '8px',
                    }}
                  >
                    <div style={{ 'min-width': '0' }}>
                      <div
                        style={{
                          color: theme.fg,
                          'font-size': sf(12),
                          'font-weight': 700,
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                          'white-space': 'nowrap',
                        }}
                      >
                        {workflow().title}
                      </div>
                      <div style={{ color: toneColor(workflow().tone), 'font-size': sf(11) }}>
                        {workflow().statusLabel}
                        <Show when={workflow().latestActivityLabel}>
                          {(label) => ` · ${label()}`}
                        </Show>
                      </div>
                    </div>
                    <button
                      aria-label="Close coordinator controls"
                      onClick={closePopover}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: theme.fgMuted,
                        cursor: 'pointer',
                        'font-size': sf(14),
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <Show when={workflow().blockedReason ?? workflow().failedLaneReason}>
                    {(reason) => (
                      <div
                        style={{
                          border: `1px solid ${theme.warning}`,
                          'border-radius': '6px',
                          padding: '6px',
                          color: theme.warning,
                          'font-size': sf(11),
                        }}
                      >
                        {reason()}
                      </div>
                    )}
                  </Show>

                  <div style={{ display: 'flex', gap: '5px', 'flex-wrap': 'wrap' }}>
                    <For each={workflow().stages}>
                      {(stage) => (
                        <span
                          title={stage.title}
                          style={{
                            display: 'inline-flex',
                            'align-items': 'center',
                            gap: '4px',
                            border: `1px solid ${toneColor(stage.tone)}`,
                            'border-radius': '6px',
                            color: toneColor(stage.tone),
                            padding: '3px 6px',
                            'font-size': sf(10),
                          }}
                        >
                          <strong>{stage.label}</strong>
                          <span>{`${stage.completedLaneCount}/${stage.laneCount}`}</span>
                        </span>
                      )}
                    </For>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
                      gap: '6px',
                      'font-size': sf(11),
                    }}
                  >
                    <span>{`Steps ${workflow().stepCount}`}</span>
                    <span>{`Appends ${workflow().appendCount}`}</span>
                    <span>{`Results ${workflow().resultCount}`}</span>
                    <span>{`Findings ${workflow().findingCount}`}</span>
                    <span>{`Failed ${workflow().failedLaneCount}`}</span>
                    <span>{`Verdicts ${
                      workflow().verdictSummary.confirmed +
                      workflow().verdictSummary.refuted +
                      workflow().verdictSummary.needsMoreEvidence
                    }`}</span>
                  </div>

                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <div style={{ color: theme.fgMuted, 'font-size': sf(11), 'font-weight': 700 }}>
                      Activity
                    </div>
                    <Show
                      when={workflow().activityPreview.length > 0}
                      fallback={
                        <div style={{ color: theme.fgSubtle, 'font-size': sf(11) }}>
                          No activity yet.
                        </div>
                      }
                    >
                      <For each={workflow().activityPreview}>
                        {(entry) => (
                          <div
                            style={{
                              display: 'grid',
                              'grid-template-columns': 'auto minmax(0, 1fr)',
                              gap: '6px',
                              color: theme.fgMuted,
                              'font-size': sf(11),
                            }}
                          >
                            <span style={{ color: toneColor(entry.tone), 'font-weight': 700 }}>
                              {entry.kind}
                            </span>
                            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                              {entry.message}
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>

                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <div style={{ color: theme.fgMuted, 'font-size': sf(11), 'font-weight': 700 }}>
                      Results
                    </div>
                    <Show
                      when={workflow().resultPreview.length > 0}
                      fallback={
                        <div style={{ color: theme.fgSubtle, 'font-size': sf(11) }}>
                          No results yet.
                        </div>
                      }
                    >
                      <For each={workflow().resultPreview}>
                        {(result) => (
                          <div
                            style={{
                              border: `1px solid ${theme.border}`,
                              'border-radius': '6px',
                              padding: '6px',
                              display: 'flex',
                              'flex-direction': 'column',
                              gap: '4px',
                              'font-size': sf(11),
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                'justify-content': 'space-between',
                                gap: '8px',
                              }}
                            >
                              <span style={{ color: toneColor(result.tone), 'font-weight': 700 }}>
                                {result.statusLabel}
                              </span>
                              <span style={{ color: theme.fgSubtle }}>
                                {result.laneLabel ?? result.stageLabel ?? result.id}
                              </span>
                            </div>
                            <div style={{ color: theme.fg }}>{result.summary}</div>
                            <div style={{ color: theme.fgMuted }}>
                              {`${result.findingCount} findings · ${result.evidenceCount} evidence · ${result.riskCount} risks`}
                            </div>
                            <For each={result.findingsPreview}>
                              {(finding) => (
                                <div style={{ color: theme.fgMuted }}>{`• ${finding}`}</div>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </Show>
                  </div>
                </>
              )}
            </Show>

            <Show when={selectedChip()}>
              {(chip) => {
                const actions = createMemo(() => {
                  const snapshot = runView();
                  if (!snapshot) {
                    return [];
                  }

                  return getCoordinatorSubtaskActions(chip(), snapshot.run);
                });
                const footerActions = createMemo(() =>
                  actions().filter(
                    (action) => action.id !== 'inspect-output' && action.id !== 'inspect-diff',
                  ),
                );
                const outputAction = createMemo(() => findAction(actions(), 'inspect-output'));
                const diffAction = createMemo(() => findAction(actions(), 'inspect-diff'));

                return (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        gap: '8px',
                      }}
                    >
                      <div style={{ 'min-width': '0' }}>
                        <div
                          style={{
                            color: theme.fg,
                            'font-size': sf(12),
                            'font-weight': 700,
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                          }}
                        >
                          {chip().assignment}
                        </div>
                        <div style={{ color: toneColor(chip().tone), 'font-size': sf(11) }}>
                          {chip().statusLabel}
                          <Show when={chip().landingLabel}>{(label) => ` · ${label()}`}</Show>
                        </div>
                      </div>
                      <button
                        aria-label="Close coordinator controls"
                        onClick={closePopover}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: theme.fgMuted,
                          cursor: 'pointer',
                          'font-size': sf(14),
                        }}
                      >
                        ×
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: '4px' }}>
                      <For each={['tail', 'diff', 'meta'] as const}>
                        {(item) => (
                          <button
                            onClick={() => setTab(item)}
                            style={{
                              border: `1px solid ${tab() === item ? theme.accent : theme.border}`,
                              'border-radius': '6px',
                              background: tab() === item ? theme.bgSelectedSubtle : 'transparent',
                              color: tab() === item ? theme.fg : theme.fgMuted,
                              cursor: 'pointer',
                              padding: '3px 8px',
                              'font-size': sf(11),
                            }}
                          >
                            {getPeekTabLabel(item)}
                          </button>
                        )}
                      </For>
                    </div>

                    <Show when={tab() === 'tail'}>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                        <button
                          class="btn-secondary"
                          disabled={
                            busyAction() === 'inspect-output' || Boolean(outputAction()?.disabled)
                          }
                          title={outputAction()?.reason}
                          onClick={() => {
                            const action = outputAction();
                            if (action) void runToolAction(action, chip());
                          }}
                        >
                          Refresh output
                        </button>
                        <pre
                          style={{
                            margin: '0',
                            height: '128px',
                            overflow: 'auto',
                            background: theme.bgInput,
                            border: `1px solid ${theme.border}`,
                            'border-radius': '6px',
                            padding: '8px',
                            color: theme.fgMuted,
                            'font-size': sf(11),
                            'white-space': 'pre-wrap',
                          }}
                        >
                          {outputResult()?.output ?? 'No output loaded.'}
                        </pre>
                        <Show when={(outputResult()?.truncatedBytes ?? 0) > 0}>
                          <div style={{ color: theme.warning, 'font-size': sf(11) }}>
                            Output truncated by {outputResult()?.truncatedBytes} bytes.
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={tab() === 'diff'}>
                      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                        <button
                          class="btn-secondary"
                          disabled={
                            busyAction() === 'inspect-diff' || Boolean(diffAction()?.disabled)
                          }
                          title={diffAction()?.reason}
                          onClick={() => {
                            const action = diffAction();
                            if (action) void runToolAction(action, chip());
                          }}
                        >
                          Refresh diff
                        </button>
                        <Show
                          when={diffResult()}
                          fallback={
                            <div style={{ color: theme.fgSubtle, 'font-size': sf(11) }}>
                              No diff loaded.
                            </div>
                          }
                        >
                          {(diff) => (
                            <>
                              <div style={{ color: theme.fgMuted, 'font-size': sf(11) }}>
                                +{diff().totalAdded} -{diff().totalRemoved}
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  'flex-direction': 'column',
                                  gap: '4px',
                                  'max-height': '120px',
                                  overflow: 'auto',
                                }}
                              >
                                <For each={diff().files}>
                                  {(file) => (
                                    <div
                                      style={{
                                        display: 'grid',
                                        'grid-template-columns': 'minmax(0, 1fr) auto',
                                        gap: '8px',
                                        'font-size': sf(11),
                                      }}
                                    >
                                      <span
                                        style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}
                                      >
                                        {getDiffFilePath(file)}
                                      </span>
                                      <span style={{ color: theme.fgMuted }}>
                                        +{getDiffFileAdded(file)} -{getDiffFileRemoved(file)}
                                      </span>
                                    </div>
                                  )}
                                </For>
                              </div>
                              <Show when={(diff().truncatedBytes ?? 0) > 0}>
                                <div style={{ color: theme.warning, 'font-size': sf(11) }}>
                                  Patch truncated by {diff().truncatedBytes} bytes.
                                </div>
                              </Show>
                            </>
                          )}
                        </Show>
                      </div>
                    </Show>

                    <Show when={tab() === 'meta'}>
                      <div
                        style={{
                          display: 'grid',
                          'grid-template-columns': 'auto minmax(0, 1fr)',
                          gap: '4px 8px',
                          'font-size': sf(11),
                          color: theme.fgMuted,
                        }}
                      >
                        <span>Task</span>
                        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                          {chip().taskId}
                        </span>
                        <span>Agent</span>
                        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                          {chip().agentId}
                        </span>
                        <span>Branch</span>
                        <span>{chip().branchName ?? 'none'}</span>
                        <span>Worktree</span>
                        <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                          {chip().worktreePath}
                        </span>
                      </div>
                    </Show>

                    <textarea
                      class="input-field"
                      aria-label="Follow-up prompt"
                      value={followUpText()}
                      onInput={(event) => setFollowUpText(event.currentTarget.value)}
                      placeholder="Send a follow-up..."
                      rows={2}
                      style={{ resize: 'vertical', 'min-height': '54px' }}
                    />
                    <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                      <For each={footerActions()}>
                        {(action) => (
                          <button
                            class={action.danger ? 'btn-danger' : 'btn-secondary'}
                            disabled={action.disabled || busyAction() === action.id}
                            title={action.reason}
                            onClick={() => void runToolAction(action, chip())}
                            style={{ 'font-size': sf(11), padding: '4px 8px' }}
                          >
                            {action.id === 'close' && closeConfirmTaskId() === chip().taskId
                              ? 'Confirm close'
                              : action.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </>
                );
              }}
            </Show>

            <Show when={showSpawn()}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div style={{ color: theme.fg, 'font-size': sf(12), 'font-weight': 700 }}>
                  Spawn subtask
                </div>
                <input
                  class="input-field"
                  aria-label="Subtask name"
                  value={spawnName()}
                  onInput={(event) => setSpawnName(event.currentTarget.value)}
                  placeholder="Name"
                />
                <input
                  class="input-field"
                  aria-label="Subtask command"
                  value={spawnCommand()}
                  onInput={(event) => setSpawnCommand(event.currentTarget.value)}
                  placeholder="Command"
                />
                <textarea
                  class="input-field"
                  aria-label="Subtask assignment"
                  value={spawnAssignment()}
                  onInput={(event) => setSpawnAssignment(event.currentTarget.value)}
                  placeholder="Assignment"
                  rows={4}
                  style={{ resize: 'vertical' }}
                />
                <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '6px' }}>
                  <button class="btn-secondary" onClick={closePopover}>
                    Cancel
                  </button>
                  <button
                    class="btn-primary"
                    disabled={busyAction() === 'spawn-subtask'}
                    onClick={() => void spawnSubtask()}
                  >
                    Spawn
                  </button>
                </div>
              </div>
            </Show>

            <Show when={showDebug()}>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div style={{ color: theme.fg, 'font-size': sf(12), 'font-weight': 700 }}>
                  Debug
                </div>
                <button class="btn-secondary" onClick={() => void copyDebugCommand()}>
                  Copy list_tasks command
                </button>
                <pre
                  style={{
                    margin: '0',
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '8px',
                    color: theme.fgMuted,
                    'font-size': sf(11),
                    overflow: 'auto',
                  }}
                >
                  {JSON.stringify(run(), null, 2)}
                </pre>
              </div>
            </Show>

            <Show when={actionError()}>
              {(message) => (
                <div role="alert" style={{ color: theme.error, 'font-size': sf(11) }}>
                  {message()}
                </div>
              )}
            </Show>
            <Show when={actionStatus()}>
              {(message) => (
                <div role="status" style={{ color: theme.success, 'font-size': sf(11) }}>
                  {message()}
                </div>
              )}
            </Show>
          </div>
        </Portal>
      </Show>
    </ScalablePanel>
  );
}

export function createTaskCoordinatorSection(props: TaskCoordinatorSectionProps): PanelChild {
  return {
    content: () => <TaskCoordinatorSection {...props} />,
    fixed: true,
    id: 'coordinator',
    initialSize: 44,
    maxSize: 64,
    minSize: 40,
  };
}
