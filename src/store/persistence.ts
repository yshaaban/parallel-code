import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { isElectronRuntime } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { cleanupPanelEntries, store, setStore } from './core';
import { randomPastelColor } from './projects';
import { clearAgentActivity, markAgentSpawned } from './taskStatus';
import { getLocalDateKey } from '../lib/date';
import type {
  Agent,
  Task,
  Terminal,
  PersistedState,
  PersistedTask,
  PersistedTaskExposedPort,
  PersistedWindowState,
  Project,
  WorkspaceSharedState,
} from './types';
import type { AgentDef } from '../ipc/types';
import { isTaskRemoving, isTerminalRemoving } from '../domain/task-closing';
import { normalizeBaseBranch } from '../lib/base-branch';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { applyHydraCommandOverride, isHydraStartupMode } from '../lib/hydra';
import { isLookPreset } from '../lib/look';
import { syncTerminalCounter } from './terminals';

function createStateSyncSourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const STATE_SYNC_SOURCE_ID = createStateSyncSourceId();
let lastLoadedStateJson: string | null = null;
let lastLoadedWorkspaceStateJson: string | null = null;
let lastLoadedWorkspaceRevision = 0;

export function getStateSyncSourceId(): string {
  return STATE_SYNC_SOURCE_ID;
}

function recordLoadedStateJson(json: string): void {
  lastLoadedStateJson = json;
}

function recordLoadedWorkspaceState(json: string, revision: number): void {
  lastLoadedWorkspaceStateJson = json;
  lastLoadedWorkspaceRevision = revision;
}

export function getLoadedWorkspaceRevision(): number {
  return lastLoadedWorkspaceRevision;
}

function getPrimaryAgentDef(task: Task): AgentDef | null {
  const agentId = task.agentIds[0];
  return agentId ? (store.agents[agentId]?.def ?? null) : null;
}

function buildPersistedExposedPorts(taskId: string): PersistedTaskExposedPort[] | undefined {
  const exposedPorts = store.taskPorts[taskId]?.exposed;
  if (!exposedPorts || exposedPorts.length === 0) {
    return undefined;
  }

  return exposedPorts.map((port) => ({
    port: port.port,
    ...(port.host !== null ? { host: port.host } : {}),
    ...(port.label !== null ? { label: port.label } : {}),
    ...(port.protocol !== 'http' ? { protocol: port.protocol } : {}),
    ...(port.source !== 'manual' ? { source: port.source } : {}),
  }));
}

function buildPersistedTask(
  task: Task,
  options?: { collapsed?: boolean; fallbackAgentDef?: AgentDef | null },
): PersistedTask {
  const exposedPorts = buildPersistedExposedPorts(task.id);
  const persistedTask: PersistedTask = {
    id: task.id,
    name: task.name,
    projectId: task.projectId,
    branchName: task.branchName,
    worktreePath: task.worktreePath,
    notes: task.notes,
    lastPrompt: task.lastPrompt,
    shellCount: task.shellAgentIds.length,
    agentId: task.agentIds[0] ?? null,
    shellAgentIds: [...task.shellAgentIds],
    agentDef: getPrimaryAgentDef(task) ?? options?.fallbackAgentDef ?? null,
    ...(task.directMode ? { directMode: true } : {}),
    ...(task.skipPermissions !== undefined ? { skipPermissions: task.skipPermissions } : {}),
    ...(task.githubUrl !== undefined ? { githubUrl: task.githubUrl } : {}),
    ...(task.savedInitialPrompt !== undefined
      ? { savedInitialPrompt: task.savedInitialPrompt }
      : {}),
    ...(task.planFileName !== undefined ? { planFileName: task.planFileName } : {}),
    ...(task.planRelativePath !== undefined ? { planRelativePath: task.planRelativePath } : {}),
    ...(exposedPorts ? { exposedPorts } : {}),
  };

  if (options?.collapsed) {
    persistedTask.collapsed = true;
  }

  return persistedTask;
}

function shouldPersistTask(task: Task | undefined): task is Task {
  return !!task && !isTaskRemoving(task);
}

function shouldPersistTerminal(terminal: Terminal | undefined): terminal is Terminal {
  return !!terminal && !isTerminalRemoving(terminal);
}

function buildPersistedActiveOrder(): string[] {
  const nextOrder: string[] = [];

  for (const id of store.taskOrder) {
    if (shouldPersistTask(store.tasks[id]) || shouldPersistTerminal(store.terminals[id])) {
      nextOrder.push(id);
    }
  }

  return nextOrder;
}

function buildPersistedCollapsedOrder(): string[] {
  return store.collapsedTaskOrder.filter((taskId) => shouldPersistTask(store.tasks[taskId]));
}

function buildWorkspaceSharedState(): WorkspaceSharedState {
  const taskOrder = buildPersistedActiveOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const persisted: WorkspaceSharedState = {
    projects: store.projects.map((project) => ({ ...project })),
    taskOrder,
    collapsedTaskOrder,
    tasks: {},
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    hydraCommand: store.hydraCommand,
    hydraForceDispatchFromPromptPanel: store.hydraForceDispatchFromPromptPanel,
    hydraStartupMode: store.hydraStartupMode,
    ...(store.customAgents.length > 0 ? { customAgents: [...store.customAgents] } : {}),
  };

  for (const taskId of taskOrder) {
    const task = store.tasks[taskId];
    if (!shouldPersistTask(task)) {
      continue;
    }
    persisted.tasks[taskId] = buildPersistedTask(task);
  }

  for (const taskId of collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!shouldPersistTask(task)) {
      continue;
    }
    persisted.tasks[taskId] = buildPersistedTask(task, {
      collapsed: true,
      fallbackAgentDef: task.savedAgentDef ?? null,
    });
  }

  for (const taskId of taskOrder) {
    const terminal = store.terminals[taskId];
    if (!shouldPersistTerminal(terminal)) {
      continue;
    }
    persisted.terminals ??= {};
    persisted.terminals[taskId] = {
      id: terminal.id,
      name: terminal.name,
      agentId: terminal.agentId,
    };
  }

  return persisted;
}

export function getWorkspaceStateSnapshotJson(): string {
  return JSON.stringify(buildWorkspaceSharedState());
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function resolvePersistedAgentId(agentId: unknown): string {
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : crypto.randomUUID();
}

function hydrateAgentDef(
  agentDef: AgentDef | null | undefined,
  availableAgents: AgentDef[],
  hydraCommand = store.hydraCommand,
): void {
  if (!agentDef) return;
  const fresh = availableAgents.find((agent) => agent.id === agentDef.id);
  if (!agentDef.adapter && agentDef.id === 'hydra') {
    agentDef.adapter = 'hydra';
  }
  if (!agentDef.adapter && fresh?.adapter) {
    agentDef.adapter = fresh.adapter;
  }
  if (!fresh) {
    agentDef.command = applyHydraCommandOverride(agentDef, hydraCommand).command;
    return;
  }
  if (!Array.isArray(agentDef.args) || (agentDef.args.length === 0 && fresh.args.length > 0)) {
    agentDef.args = [...fresh.args];
  }
  if (
    !Array.isArray(agentDef.resume_args) ||
    (agentDef.resume_args.length === 0 && fresh.resume_args.length > 0)
  ) {
    agentDef.resume_args = [...fresh.resume_args];
  }
  if (
    !Array.isArray(agentDef.skip_permissions_args) ||
    (agentDef.skip_permissions_args.length === 0 && fresh.skip_permissions_args.length > 0)
  ) {
    agentDef.skip_permissions_args = [...fresh.skip_permissions_args];
  }
  agentDef.command = applyHydraCommandOverride(agentDef, hydraCommand).command;
}

export async function saveState(): Promise<void> {
  const taskOrder = buildPersistedActiveOrder();
  const collapsedTaskOrder = buildPersistedCollapsedOrder();
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder,
    collapsedTaskOrder,
    tasks: {},
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    autoTrustFolders: store.autoTrustFolders,
    hydraForceDispatchFromPromptPanel: store.hydraForceDispatchFromPromptPanel,
    hydraStartupMode: store.hydraStartupMode,
    ...(store.editorCommand ? { editorCommand: store.editorCommand } : {}),
    ...(store.hydraCommand ? { hydraCommand: store.hydraCommand } : {}),
    ...(store.customAgents.length > 0 ? { customAgents: [...store.customAgents] } : {}),
  };

  if (isElectronRuntime()) {
    persisted.activeTaskId = store.activeTaskId;
    persisted.sidebarVisible = store.sidebarVisible;
    persisted.fontScales = { ...store.fontScales };
    persisted.panelSizes = { ...store.panelSizes };
    persisted.globalScale = store.globalScale;
    persisted.terminalFont = store.terminalFont;
    persisted.themePreset = store.themePreset;
    persisted.showPlans = store.showPlans;
    persisted.inactiveColumnOpacity = store.inactiveColumnOpacity;
    persisted.hasSeenDesktopIntro = store.hasSeenDesktopIntro;
    if (store.windowState) {
      persisted.windowState = { ...store.windowState };
    }
  }

  for (const taskId of taskOrder) {
    const task = store.tasks[taskId];
    if (!shouldPersistTask(task)) continue;
    persisted.tasks[taskId] = buildPersistedTask(task);
  }

  for (const taskId of collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!shouldPersistTask(task)) continue;
    persisted.tasks[taskId] = buildPersistedTask(task, {
      collapsed: true,
      fallbackAgentDef: task.savedAgentDef ?? null,
    });
  }

  for (const id of taskOrder) {
    const terminal = store.terminals[id];
    if (!shouldPersistTerminal(terminal)) continue;
    persisted.terminals ??= {};
    persisted.terminals[id] = { id: terminal.id, name: terminal.name, agentId: terminal.agentId };
  }

  const json = JSON.stringify(persisted);
  recordLoadedStateJson(json);

  await invoke(IPC.SaveAppState, {
    json,
    sourceId: STATE_SYNC_SOURCE_ID,
  }).catch((e) => console.warn('Failed to save state:', e));
}

function isStringNumberRecord(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === 'number' && Number.isFinite(val),
  );
}

function parsePersistedWindowState(v: unknown): PersistedWindowState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;

  const raw = v as Record<string, unknown>;
  const x = raw.x;
  const y = raw.y;
  const width = raw.width;
  const height = raw.height;
  const maximized = raw.maximized;

  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof maximized !== 'boolean'
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized,
  };
}

interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  // Fields that may be present in newer state files (validated at runtime)
  fontScales?: unknown;
  panelSizes?: unknown;
  globalScale?: unknown;
  completedTaskDate?: unknown;
  completedTaskCount?: unknown;
  mergedLinesAdded?: unknown;
  mergedLinesRemoved?: unknown;
  terminalFont?: unknown;
  themePreset?: unknown;
  windowState?: unknown;
  autoTrustFolders?: unknown;
  showPlans?: unknown;
  inactiveColumnOpacity?: unknown;
  hasSeenDesktopIntro?: unknown;
  editorCommand?: unknown;
  hydraCommand?: unknown;
  hydraForceDispatchFromPromptPanel?: unknown;
  hydraStartupMode?: unknown;
  customAgents?: unknown;
  terminals?: unknown;
}

function createWorkspaceStateBaseAgents(
  raw: LegacyPersistedState,
  restoredHydraCommand: string,
): {
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
} {
  const defaultAvailableAgents = store.availableAgents.filter(
    (agent) => !store.customAgents.some((custom) => custom.id === agent.id),
  );
  const customAgents = Array.isArray(raw.customAgents)
    ? raw.customAgents
        .filter(
          (agent: unknown): agent is AgentDef =>
            typeof agent === 'object' &&
            agent !== null &&
            typeof (agent as AgentDef).id === 'string' &&
            typeof (agent as AgentDef).name === 'string' &&
            typeof (agent as AgentDef).command === 'string',
        )
        .map((agent) => applyHydraCommandOverride(agent, restoredHydraCommand))
    : [];
  const availableAgents = defaultAvailableAgents.map((agent) =>
    applyHydraCommandOverride(agent, restoredHydraCommand),
  );

  for (const customAgent of customAgents) {
    if (!availableAgents.some((agent) => agent.id === customAgent.id)) {
      availableAgents.push(applyHydraCommandOverride(customAgent, restoredHydraCommand));
    }
  }

  return {
    availableAgents,
    customAgents,
  };
}

function parseSharedProjects(raw: LegacyPersistedState): {
  lastProjectId: string | null;
  projects: Project[];
} {
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;

  for (const project of projects) {
    if (!project.color) {
      project.color = randomPastelColor();
    }
    const baseBranch = normalizeBaseBranch(project.baseBranch);
    if (baseBranch !== undefined) {
      project.baseBranch = baseBranch;
    } else {
      delete project.baseBranch;
    }
  }

  if (projects.length === 0 && raw.projectRoot) {
    const segments = raw.projectRoot.split('/');
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = crypto.randomUUID();
    projects = [{ id, name, path: raw.projectRoot, color: randomPastelColor() }];
    lastProjectId = id;

    for (const taskId of raw.taskOrder) {
      const persistedTask = raw.tasks[taskId];
      if (persistedTask && !persistedTask.projectId) {
        persistedTask.projectId = id;
      }
    }
  }

  return {
    lastProjectId,
    projects,
  };
}

function isLegacyPersistedState(raw: unknown): raw is LegacyPersistedState {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as LegacyPersistedState).taskOrder) &&
    typeof (raw as LegacyPersistedState).tasks === 'object'
  );
}

function buildHydratedTask(
  persistedTask: PersistedTask & { projectId?: string },
  availableAgents: AgentDef[],
  hydraCommand: string,
  existingTask: Task | undefined,
  collapsed: boolean,
): {
  agentDef: AgentDef | null | undefined;
  primaryAgentId: string | null;
  shellAgentIds: string[];
  task: Task;
} {
  const agentDef = persistedTask.agentDef;
  hydrateAgentDef(agentDef, availableAgents, hydraCommand);

  const primaryAgentId = agentDef
    ? resolvePersistedAgentId(persistedTask.agentId ?? existingTask?.agentIds[0])
    : null;

  let shellAgentIds = Array.isArray(persistedTask.shellAgentIds)
    ? persistedTask.shellAgentIds.filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
    : [];
  if (shellAgentIds.length === 0) {
    shellAgentIds = [...(existingTask?.shellAgentIds ?? [])];
  }
  if (shellAgentIds.length === 0) {
    for (let index = 0; index < persistedTask.shellCount; index += 1) {
      shellAgentIds.push(crypto.randomUUID());
    }
  }

  const task: Task = {
    id: persistedTask.id,
    name: persistedTask.name,
    projectId: persistedTask.projectId ?? '',
    branchName: persistedTask.branchName,
    worktreePath: persistedTask.worktreePath,
    agentIds: collapsed || !primaryAgentId ? [] : [primaryAgentId],
    shellAgentIds: collapsed ? [] : shellAgentIds,
    notes: persistedTask.notes,
    lastPrompt: persistedTask.lastPrompt,
    skipPermissions: persistedTask.skipPermissions === true,
    ...(persistedTask.directMode ? { directMode: true } : {}),
    ...(persistedTask.githubUrl !== undefined ? { githubUrl: persistedTask.githubUrl } : {}),
    ...(persistedTask.savedInitialPrompt !== undefined
      ? { savedInitialPrompt: persistedTask.savedInitialPrompt }
      : {}),
    ...(persistedTask.planFileName !== undefined
      ? { planFileName: persistedTask.planFileName }
      : {}),
    ...(persistedTask.planRelativePath !== undefined
      ? { planRelativePath: persistedTask.planRelativePath }
      : {}),
    ...(collapsed ? { collapsed: true } : {}),
    ...(collapsed && agentDef ? { savedAgentDef: agentDef } : {}),
  };

  return {
    agentDef,
    primaryAgentId,
    shellAgentIds,
    task,
  };
}

export function applyLoadedStateJson(json: string): boolean {
  if (json === lastLoadedStateJson) {
    return false;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted state');
    return false;
  }

  if (!isLegacyPersistedState(raw)) {
    console.warn('Invalid persisted state structure, skipping load');
    return false;
  }

  const restoredRunningAgentIds: string[] = [];
  const today = getLocalDateKey();
  const restoredHydraCommand = typeof raw.hydraCommand === 'string' ? raw.hydraCommand.trim() : '';
  const electronRuntime = isElectronRuntime();
  const { availableAgents, customAgents } = createWorkspaceStateBaseAgents(
    raw,
    restoredHydraCommand,
  );
  const { lastProjectId, projects } = parseSharedProjects(raw);
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  setStore(
    produce((s) => {
      s.tasks = {};
      s.terminals = {};
      s.agents = {};
      s.agentSupervision = {};
      s.agentActive = {};
      s.taskGitStatus = {};
      s.taskPorts = {};
      s.taskConvergence = {};
      s.taskReview = {};
      s.focusedPanel = {};
      s.missingProjectIds = {};
      s.activeAgentId = null;
      s.sidebarFocused = false;
      s.sidebarFocusedProjectId = null;
      s.sidebarFocusedTaskId = null;
      s.placeholderFocused = false;
      s.placeholderFocusedButton = 'add-task';
      s.customAgents = customAgents;
      s.availableAgents = availableAgents;
      s.projects = projects;
      s.lastProjectId = lastProjectId;
      s.lastAgentId = lastAgentId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = electronRuntime ? raw.activeTaskId : null;
      s.sidebarVisible =
        electronRuntime && typeof raw.sidebarVisible === 'boolean' ? raw.sidebarVisible : true;
      s.fontScales = electronRuntime && isStringNumberRecord(raw.fontScales) ? raw.fontScales : {};
      s.panelSizes = electronRuntime && isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {};
      s.globalScale = electronRuntime && typeof raw.globalScale === 'number' ? raw.globalScale : 1;
      const completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      const completedTaskCount = toNonNegativeInt(raw.completedTaskCount);
      if (completedTaskDate === today) {
        s.completedTaskDate = completedTaskDate;
        s.completedTaskCount = completedTaskCount;
      } else {
        s.completedTaskDate = today;
        s.completedTaskCount = 0;
      }
      s.mergedLinesAdded = toNonNegativeInt(raw.mergedLinesAdded);
      s.mergedLinesRemoved = toNonNegativeInt(raw.mergedLinesRemoved);
      s.terminalFont =
        electronRuntime && isTerminalFont(raw.terminalFont)
          ? raw.terminalFont
          : DEFAULT_TERMINAL_FONT;
      s.themePreset =
        electronRuntime && isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal';
      s.windowState = electronRuntime ? parsePersistedWindowState(raw.windowState) : null;
      s.autoTrustFolders = typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
      s.showPlans = electronRuntime && typeof raw.showPlans === 'boolean' ? raw.showPlans : true;
      const rawOpacity = raw.inactiveColumnOpacity;
      s.inactiveColumnOpacity =
        electronRuntime &&
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;
      s.hasSeenDesktopIntro =
        electronRuntime && typeof raw.hasSeenDesktopIntro === 'boolean'
          ? raw.hasSeenDesktopIntro
          : false;

      const rawEditorCommand = raw.editorCommand;
      s.editorCommand = typeof rawEditorCommand === 'string' ? rawEditorCommand.trim() : '';
      s.hydraCommand = restoredHydraCommand;
      s.hydraForceDispatchFromPromptPanel =
        typeof raw.hydraForceDispatchFromPromptPanel === 'boolean'
          ? raw.hydraForceDispatchFromPromptPanel
          : true;
      const rawHydraStartupMode =
        typeof raw.hydraStartupMode === 'string' ? raw.hydraStartupMode : undefined;
      s.hydraStartupMode = isHydraStartupMode(rawHydraStartupMode) ? rawHydraStartupMode : 'auto';

      for (const taskId of raw.taskOrder) {
        const persistedTask = raw.tasks[taskId];
        if (!persistedTask) continue;

        const hydratedTask = buildHydratedTask(
          persistedTask,
          s.availableAgents,
          restoredHydraCommand,
          undefined,
          false,
        );
        s.tasks[taskId] = hydratedTask.task;

        if (hydratedTask.agentDef && hydratedTask.primaryAgentId) {
          const agent: Agent = {
            id: hydratedTask.primaryAgentId,
            taskId,
            def: hydratedTask.agentDef,
            resumed: true,
            status: 'running',
            exitCode: null,
            signal: null,
            lastOutput: [],
            generation: 0,
          };
          s.agents[hydratedTask.primaryAgentId] = agent;
          restoredRunningAgentIds.push(hydratedTask.primaryAgentId);
        }
      }

      // Restore terminals
      const rawTerminals = (raw.terminals ?? {}) as Record<
        string,
        { id: string; name: string; agentId?: string }
      >;
      for (const termId of raw.taskOrder) {
        const pt = rawTerminals[termId];
        if (!pt) continue;
        const agentId = resolvePersistedAgentId(pt.agentId);
        s.terminals[termId] = { id: pt.id, name: pt.name, agentId };
      }

      // Remove orphaned entries from taskOrder
      s.taskOrder = s.taskOrder.filter((id) => s.tasks[id] || s.terminals[id]);

      // Restore collapsed tasks
      const collapsedOrder = raw.collapsedTaskOrder ?? [];
      for (const taskId of collapsedOrder) {
        const persistedTask = raw.tasks[taskId];
        if (!persistedTask || !persistedTask.collapsed) continue;

        const hydratedTask = buildHydratedTask(
          persistedTask,
          s.availableAgents,
          restoredHydraCommand,
          undefined,
          true,
        );
        s.tasks[taskId] = hydratedTask.task;
      }
      s.collapsedTaskOrder = collapsedOrder.filter((id) => s.tasks[id]);

      // Defensive: ensure no task appears in both arrays (corrupted state)
      const activeSet = new Set(s.taskOrder);
      s.collapsedTaskOrder = s.collapsedTaskOrder.filter((id) => !activeSet.has(id));

      // Set activeAgentId from the active task
      if (electronRuntime && s.activeTaskId) {
        const activeTask = s.tasks[s.activeTaskId];
        if (activeTask) {
          s.activeAgentId = activeTask.agentIds[0] ?? null;
        }
      }
    }),
  );

  // Restored agents are considered running; reflect that immediately in task status dots.
  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  recordLoadedStateJson(json);
  syncTerminalCounter();
  return true;
}

export function applyLoadedWorkspaceStateJson(json: string, revision = 0): boolean {
  if (json === lastLoadedWorkspaceStateJson && revision === lastLoadedWorkspaceRevision) {
    return false;
  }

  let raw: LegacyPersistedState;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted workspace state');
    return false;
  }

  if (!isLegacyPersistedState(raw)) {
    console.warn('Invalid persisted workspace state structure, skipping load');
    return false;
  }

  const today = getLocalDateKey();
  const restoredHydraCommand = typeof raw.hydraCommand === 'string' ? raw.hydraCommand.trim() : '';
  const { availableAgents, customAgents } = createWorkspaceStateBaseAgents(
    raw,
    restoredHydraCommand,
  );
  const { lastProjectId, projects } = parseSharedProjects(raw);
  const currentTasksById = new Map(Object.entries(store.tasks));
  const nextTaskIds = new Set([...raw.taskOrder, ...(raw.collapsedTaskOrder ?? [])]);
  const removedAgentIds = new Set<string>();

  function removeTerminalWorkspaceState(
    storeState: typeof store,
    terminalId: string,
    agentsToDelete: Set<string>,
  ): void {
    const terminal = storeState.terminals[terminalId];
    if (!terminal) {
      return;
    }

    agentsToDelete.add(terminal.agentId);
    cleanupPanelEntries(storeState, terminalId);
    delete storeState.terminals[terminalId];
  }

  setStore(
    produce((storeState) => {
      const agentsToDelete = new Set<string>();

      for (const [taskId, task] of Object.entries(storeState.tasks)) {
        if (nextTaskIds.has(taskId)) {
          continue;
        }

        task.agentIds.forEach((agentId) => agentsToDelete.add(agentId));
        task.shellAgentIds.forEach((agentId) => agentsToDelete.add(agentId));
        cleanupPanelEntries(storeState, taskId);
        delete storeState.tasks[taskId];
        removeTerminalWorkspaceState(storeState, taskId, agentsToDelete);
        delete storeState.taskGitStatus[taskId];
        delete storeState.taskPorts[taskId];
        delete storeState.taskConvergence[taskId];
        delete storeState.taskReview[taskId];
        delete storeState.taskCommandControllers[taskId];
      }

      storeState.projects = projects;
      storeState.lastProjectId = lastProjectId;
      storeState.completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      storeState.completedTaskCount = toNonNegativeInt(raw.completedTaskCount);
      storeState.mergedLinesAdded = toNonNegativeInt(raw.mergedLinesAdded);
      storeState.mergedLinesRemoved = toNonNegativeInt(raw.mergedLinesRemoved);
      storeState.hydraCommand = restoredHydraCommand;
      storeState.hydraForceDispatchFromPromptPanel =
        typeof raw.hydraForceDispatchFromPromptPanel === 'boolean'
          ? raw.hydraForceDispatchFromPromptPanel
          : true;
      const rawHydraStartupMode =
        typeof raw.hydraStartupMode === 'string' ? raw.hydraStartupMode : undefined;
      storeState.hydraStartupMode = isHydraStartupMode(rawHydraStartupMode)
        ? rawHydraStartupMode
        : 'auto';
      storeState.customAgents = customAgents;
      storeState.availableAgents = availableAgents;

      for (const taskId of raw.taskOrder) {
        const persistedTask = raw.tasks[taskId];
        if (!persistedTask) {
          continue;
        }

        const existingTask = currentTasksById.get(taskId);
        const hydratedTask = buildHydratedTask(
          persistedTask,
          availableAgents,
          restoredHydraCommand,
          existingTask,
          false,
        );
        const previousTask = storeState.tasks[taskId];
        previousTask?.agentIds.forEach((agentId) => agentsToDelete.add(agentId));
        previousTask?.shellAgentIds.forEach((agentId) => agentsToDelete.add(agentId));
        hydratedTask.task.agentIds.forEach((agentId) => agentsToDelete.delete(agentId));
        hydratedTask.task.shellAgentIds.forEach((agentId) => agentsToDelete.delete(agentId));
        storeState.tasks[taskId] = hydratedTask.task;

        if (hydratedTask.agentDef && hydratedTask.primaryAgentId) {
          const previousAgent = storeState.agents[hydratedTask.primaryAgentId];
          storeState.agents[hydratedTask.primaryAgentId] = previousAgent
            ? {
                ...previousAgent,
                def: hydratedTask.agentDef,
                taskId,
              }
            : {
                id: hydratedTask.primaryAgentId,
                taskId,
                def: hydratedTask.agentDef,
                resumed: true,
                status: 'running',
                exitCode: null,
                signal: null,
                lastOutput: [],
                generation: 0,
              };
        }
      }

      const collapsedTaskOrder = raw.collapsedTaskOrder ?? [];
      for (const taskId of collapsedTaskOrder) {
        const persistedTask = raw.tasks[taskId];
        if (!persistedTask || !persistedTask.collapsed) {
          continue;
        }

        const hydratedTask = buildHydratedTask(
          persistedTask,
          availableAgents,
          restoredHydraCommand,
          currentTasksById.get(taskId),
          true,
        );
        const previousTask = storeState.tasks[taskId];
        previousTask?.agentIds.forEach((agentId) => agentsToDelete.add(agentId));
        previousTask?.shellAgentIds.forEach((agentId) => agentsToDelete.add(agentId));
        storeState.tasks[taskId] = hydratedTask.task;
      }

      const rawTerminals = (raw.terminals ?? {}) as Record<
        string,
        { id: string; name: string; agentId?: string }
      >;
      const activeTerminalIds = new Set(raw.taskOrder);
      for (const existingTerminalId of Object.keys(storeState.terminals)) {
        if (!activeTerminalIds.has(existingTerminalId)) {
          removeTerminalWorkspaceState(storeState, existingTerminalId, agentsToDelete);
        }
      }
      for (const terminalId of raw.taskOrder) {
        const persistedTerminal = rawTerminals[terminalId];
        if (!persistedTerminal) {
          continue;
        }
        const existingTerminal = storeState.terminals[terminalId];
        const resolvedAgentId = resolvePersistedAgentId(
          persistedTerminal.agentId ?? existingTerminal?.agentId,
        );
        storeState.terminals[terminalId] = {
          id: persistedTerminal.id,
          name: persistedTerminal.name,
          agentId: resolvedAgentId,
        };
      }

      for (const agentId of agentsToDelete) {
        delete storeState.agents[agentId];
        delete storeState.agentActive[agentId];
        delete storeState.agentSupervision[agentId];
        removedAgentIds.add(agentId);
      }

      for (const taskId of Object.keys(storeState.taskCommandControllers)) {
        if (storeState.tasks[taskId]) {
          continue;
        }

        delete storeState.taskCommandControllers[taskId];
      }

      storeState.taskOrder = raw.taskOrder.filter(
        (taskId) => storeState.tasks[taskId] || storeState.terminals[taskId],
      );
      const activeTaskSet = new Set(storeState.taskOrder);
      storeState.collapsedTaskOrder = collapsedTaskOrder.filter(
        (taskId) => storeState.tasks[taskId] && !activeTaskSet.has(taskId),
      );
    }),
  );

  for (const agentId of removedAgentIds) {
    clearAgentActivity(agentId);
  }

  recordLoadedWorkspaceState(json, revision);
  syncTerminalCounter();
  return true;
}

export async function saveBrowserWorkspaceState(): Promise<void> {
  const json = JSON.stringify(buildWorkspaceSharedState());
  await saveBrowserWorkspaceStateSnapshot(json);
}

export async function saveBrowserWorkspaceStateSnapshot(json: string): Promise<void> {
  const response = await invoke(IPC.SaveWorkspaceState, {
    baseRevision: getLoadedWorkspaceRevision(),
    json,
    sourceId: STATE_SYNC_SOURCE_ID,
  });
  recordLoadedWorkspaceState(json, response.revision);
}

export async function saveCurrentRuntimeState(): Promise<void> {
  if (isElectronRuntime()) {
    await saveState();
    return;
  }

  await saveBrowserWorkspaceState();
}

export async function loadWorkspaceState(): Promise<boolean> {
  const payload = await invoke(IPC.LoadWorkspaceState).catch(() => null);
  if (!payload?.json) {
    return false;
  }

  return applyLoadedWorkspaceStateJson(payload.json, payload.revision);
}

export async function loadState(): Promise<boolean> {
  const json = await invoke(IPC.LoadAppState).catch(() => null);
  if (!json) {
    return false;
  }

  return applyLoadedStateJson(json);
}
