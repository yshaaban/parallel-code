import { expect, type Page } from '@playwright/test';

import { IPC } from '../../../electron/ipc/channels.js';

const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';
const TERMINAL_STATUS_SELECTOR = '[data-terminal-status]';
const TERMINAL_LOADING_OVERLAY_SELECTOR = '[data-terminal-loading-overlay="true"]';

type BrowserLabIpcHarness = {
  invokeIpc: <TResult>(request: unknown, channel: IPC, body?: unknown) => Promise<TResult>;
};

interface AgentSupervisionSnapshot {
  agentId: string;
  state: string;
  taskId: string;
}

interface TaskCommandControllersResult {
  controllers: Array<{
    action: string | null;
    controllerId: string | null;
    taskId: string;
  }>;
}

export interface TerminalOperationalSnapshot {
  activeTerminalIndex: number;
  agentId: string | null;
  cursorBlink: boolean;
  hasDocumentFocus: boolean;
  liveRenderReady: boolean;
  loadingOverlayVisible: boolean;
  presentationMode: string | null;
  renderHibernating: boolean;
  restoreBlocked: boolean;
  status: string | null;
  surfaceTier: string | null;
  visibilityState: string;
}

export interface LifecycleInvariantSnapshot {
  controllerId: string | null;
  controllerTaskId: string | null;
  supervisionState: string | null;
  supervisionTaskId: string | null;
  terminal: TerminalOperationalSnapshot;
}

export interface AssertLifecycleInvariantsOptions {
  requireCursorBlink?: boolean;
  expectedControllerId?: string | null;
  forbidSupervisionStates?: readonly string[];
  forbidTerminalStatuses?: readonly string[];
  requireDocumentFocus?: boolean;
  requireLiveRenderReady?: boolean;
  requireLoadingOverlayHidden?: boolean;
  requireRestoreUnblocked?: boolean;
  requireStatus?: string | null;
  terminalIndex?: number;
  timeoutMs?: number;
}

export async function readTerminalOperationalSnapshot(
  page: Page,
  terminalIndex = 0,
): Promise<TerminalOperationalSnapshot> {
  return page.evaluate(
    ({ inputSelector, loadingOverlaySelector, statusSelector, terminalIndex: index }) => {
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>(inputSelector));
      const input = inputs[index];
      const statusElement = input?.closest(statusSelector);
      const activeTerminalIndex = inputs.findIndex((element) => element === document.activeElement);

      return {
        activeTerminalIndex,
        agentId: statusElement?.getAttribute('data-terminal-agent-id') ?? null,
        cursorBlink: statusElement?.getAttribute('data-terminal-cursor-blink') === 'true',
        hasDocumentFocus: document.hasFocus(),
        liveRenderReady: statusElement?.getAttribute('data-terminal-live-render-ready') === 'true',
        loadingOverlayVisible:
          statusElement?.querySelector(loadingOverlaySelector) instanceof HTMLElement,
        presentationMode: statusElement?.getAttribute('data-terminal-presentation-mode') ?? null,
        renderHibernating:
          statusElement?.getAttribute('data-terminal-render-hibernating') === 'true',
        restoreBlocked: statusElement?.getAttribute('data-terminal-restore-blocked') === 'true',
        status: statusElement?.getAttribute('data-terminal-status') ?? null,
        surfaceTier: statusElement?.getAttribute('data-terminal-surface-tier') ?? null,
        visibilityState: document.visibilityState,
      };
    },
    {
      inputSelector: TERMINAL_INPUT_SELECTOR,
      loadingOverlaySelector: TERMINAL_LOADING_OVERLAY_SELECTOR,
      statusSelector: TERMINAL_STATUS_SELECTOR,
      terminalIndex,
    },
  );
}

export async function readLifecycleInvariantSnapshot(
  browserLab: BrowserLabIpcHarness,
  request: unknown,
  page: Page,
  taskId: string,
  terminalIndex = 0,
): Promise<LifecycleInvariantSnapshot> {
  const terminal = await readTerminalOperationalSnapshot(page, terminalIndex);
  const supervision = terminal.agentId
    ? await browserLab.invokeIpc<AgentSupervisionSnapshot[]>(request, IPC.GetAgentSupervision)
    : [];
  const controllers = await browserLab.invokeIpc<TaskCommandControllersResult>(
    request,
    IPC.GetTaskCommandControllers,
  );
  const supervisionEntry =
    terminal.agentId === null
      ? null
      : (supervision.find((entry) => entry.agentId === terminal.agentId) ?? null);
  const controllerEntry = controllers.controllers.find((entry) => entry.taskId === taskId) ?? null;

  return {
    controllerId: controllerEntry?.controllerId ?? null,
    controllerTaskId: controllerEntry?.taskId ?? null,
    supervisionState: supervisionEntry?.state ?? null,
    supervisionTaskId: supervisionEntry?.taskId ?? null,
    terminal,
  };
}

export async function assertTerminalLifecycleInvariants(
  browserLab: BrowserLabIpcHarness,
  request: unknown,
  page: Page,
  taskId: string,
  options: AssertLifecycleInvariantsOptions = {},
): Promise<LifecycleInvariantSnapshot> {
  const forbidSupervisionStates = options.forbidSupervisionStates ?? [
    'flow-controlled',
    'restoring',
  ];
  const forbidTerminalStatuses = options.forbidTerminalStatuses ?? [
    'attaching',
    'binding',
    'restoring',
  ];
  const requireCursorBlink = options.requireCursorBlink;
  const requireDocumentFocus = options.requireDocumentFocus ?? false;
  const requireLiveRenderReady = options.requireLiveRenderReady ?? true;
  const requireLoadingOverlayHidden = options.requireLoadingOverlayHidden ?? true;
  const requireRestoreUnblocked = options.requireRestoreUnblocked ?? false;
  const requireStatus = options.requireStatus ?? 'ready';
  const terminalIndex = options.terminalIndex ?? 0;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let snapshot: LifecycleInvariantSnapshot | null = null;
  await expect
    .poll(
      async () => {
        snapshot = await readLifecycleInvariantSnapshot(
          browserLab,
          request,
          page,
          taskId,
          terminalIndex,
        );
        const terminal = snapshot.terminal;
        const failures: string[] = [];

        if (requireStatus !== null && terminal.status !== requireStatus) {
          failures.push(`terminal-status:${terminal.status ?? 'null'}`);
        }
        if (forbidTerminalStatuses.includes(terminal.status ?? '')) {
          failures.push(`forbidden-terminal-status:${terminal.status}`);
        }
        if (requireLiveRenderReady && terminal.liveRenderReady !== true) {
          failures.push('terminal-live-render-ready:false');
        }
        if (requireCursorBlink === true && terminal.cursorBlink !== true) {
          failures.push('terminal-cursor-blink:false');
        }
        if (requireCursorBlink === false && terminal.cursorBlink !== false) {
          failures.push('terminal-cursor-blink:true');
        }
        if (requireLoadingOverlayHidden && terminal.loadingOverlayVisible) {
          failures.push('terminal-loading-overlay:true');
        }
        if (requireRestoreUnblocked && terminal.restoreBlocked) {
          failures.push('terminal-restore-blocked:true');
        }
        if (requireDocumentFocus) {
          if (terminal.hasDocumentFocus !== true) {
            failures.push('document-focus:false');
          }
          if (terminal.activeTerminalIndex !== terminalIndex) {
            failures.push(`active-terminal-index:${terminal.activeTerminalIndex}`);
          }
          if (terminal.visibilityState !== 'visible') {
            failures.push(`visibility:${terminal.visibilityState}`);
          }
        }
        if (forbidSupervisionStates.includes(snapshot.supervisionState ?? '')) {
          failures.push(`forbidden-supervision:${snapshot.supervisionState}`);
        }
        if (
          options.expectedControllerId !== undefined &&
          snapshot.controllerId !== options.expectedControllerId
        ) {
          failures.push(`controller:${snapshot.controllerId ?? 'null'}`);
        }

        return failures.length === 0 ? 'ok' : failures.join(', ');
      },
      { timeout: timeoutMs },
    )
    .toBe('ok');

  return snapshot as LifecycleInvariantSnapshot;
}

export async function assertInteractiveTerminalLifecycleInvariants(
  browserLab: BrowserLabIpcHarness,
  request: unknown,
  page: Page,
  taskId: string,
  options: Omit<AssertLifecycleInvariantsOptions, 'requireCursorBlink'> = {},
): Promise<LifecycleInvariantSnapshot> {
  return assertTerminalLifecycleInvariants(browserLab, request, page, taskId, {
    ...options,
    requireCursorBlink: true,
    requireRestoreUnblocked: options.requireRestoreUnblocked ?? true,
  });
}
