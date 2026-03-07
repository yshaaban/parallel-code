import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { randomPastelColor } from './projects';
import { markAgentSpawned } from './taskStatus';
import { getLocalDateKey } from '../lib/date';
import type {
  Agent,
  Task,
  PersistedState,
  PersistedTask,
  PersistedWindowState,
  Project,
} from './types';
import type { AgentDef } from '../ipc/types';
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

export function getStateSyncSourceId(): string {
  return STATE_SYNC_SOURCE_ID;
}

function getPrimaryAgentDef(task: Task): AgentDef | null {
  const agentId = task.agentIds[0];
  return agentId ? (store.agents[agentId]?.def ?? null) : null;
}

function buildPersistedTask(
  task: Task,
  options?: { collapsed?: boolean; fallbackAgentDef?: AgentDef | null },
): PersistedTask & { projectId?: string } {
  const persistedTask: PersistedTask & { projectId?: string } = {
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
    directMode: task.directMode,
    skipPermissions: task.skipPermissions,
    githubUrl: task.githubUrl,
    savedInitialPrompt: task.savedInitialPrompt,
  };

  if (options?.collapsed) {
    persistedTask.collapsed = true;
  }

  return persistedTask;
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
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: [...store.taskOrder],
    collapsedTaskOrder: [...store.collapsedTaskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: { ...store.fontScales },
    panelSizes: { ...store.panelSizes },
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    windowState: store.windowState ? { ...store.windowState } : undefined,
    autoTrustFolders: store.autoTrustFolders,
    showPlans: store.showPlans,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    editorCommand: store.editorCommand || undefined,
    hydraCommand: store.hydraCommand || undefined,
    hydraForceDispatchFromPromptPanel: store.hydraForceDispatchFromPromptPanel,
    hydraStartupMode: store.hydraStartupMode,
    customAgents: store.customAgents.length > 0 ? [...store.customAgents] : undefined,
  };

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;
    persisted.tasks[taskId] = buildPersistedTask(task);
  }

  for (const taskId of store.collapsedTaskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;
    persisted.tasks[taskId] = buildPersistedTask(task, {
      collapsed: true,
      fallbackAgentDef: task.savedAgentDef ?? null,
    });
  }

  for (const id of store.taskOrder) {
    const terminal = store.terminals[id];
    if (!terminal) continue;
    persisted.terminals ??= {};
    persisted.terminals[id] = { id: terminal.id, name: terminal.name, agentId: terminal.agentId };
  }

  await invoke(IPC.SaveAppState, {
    json: JSON.stringify(persisted),
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
  editorCommand?: unknown;
  hydraCommand?: unknown;
  hydraForceDispatchFromPromptPanel?: unknown;
  hydraStartupMode?: unknown;
  customAgents?: unknown;
  terminals?: unknown;
}

export async function loadState(): Promise<void> {
  const json = await invoke<string | null>(IPC.LoadAppState).catch(() => null);
  if (!json) return;

  let raw: LegacyPersistedState;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted state');
    return;
  }

  // Validate essential structure
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.taskOrder) ||
    typeof raw.tasks !== 'object'
  ) {
    console.warn('Invalid persisted state structure, skipping load');
    return;
  }

  // Migrate from old format if needed
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  // Assign colors to projects that don't have one (backward compat)
  for (const p of projects) {
    if (!p.color) p.color = randomPastelColor();
  }

  if (projects.length === 0 && raw.projectRoot) {
    const segments = raw.projectRoot.split('/');
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = crypto.randomUUID();
    projects = [{ id, name, path: raw.projectRoot, color: randomPastelColor() }];
    lastProjectId = id;

    // Assign this project to all existing tasks
    for (const taskId of raw.taskOrder) {
      const pt = raw.tasks[taskId];
      if (pt && !pt.projectId) {
        pt.projectId = id;
      }
    }
  }

  const restoredRunningAgentIds: string[] = [];
  const today = getLocalDateKey();
  const restoredHydraCommand = typeof raw.hydraCommand === 'string' ? raw.hydraCommand.trim() : '';
  const defaultAvailableAgents = store.availableAgents.filter(
    (agent) => !store.customAgents.some((custom) => custom.id === agent.id),
  );

  setStore(
    produce((s) => {
      s.tasks = {};
      s.terminals = {};
      s.agents = {};
      s.taskGitStatus = {};
      s.focusedPanel = {};
      s.missingProjectIds = {};
      s.activeAgentId = null;
      s.sidebarFocused = false;
      s.sidebarFocusedProjectId = null;
      s.sidebarFocusedTaskId = null;
      s.placeholderFocused = false;
      s.placeholderFocusedButton = 'add-task';
      s.customAgents = [];
      s.availableAgents = defaultAvailableAgents.map((agent) =>
        applyHydraCommandOverride(agent, restoredHydraCommand),
      );
      s.projects = projects;
      s.lastProjectId = lastProjectId;
      s.lastAgentId = lastAgentId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = raw.activeTaskId;
      s.sidebarVisible = raw.sidebarVisible;
      s.fontScales = isStringNumberRecord(raw.fontScales) ? raw.fontScales : {};
      s.panelSizes = isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {};
      s.globalScale = typeof raw.globalScale === 'number' ? raw.globalScale : 1;
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
      s.terminalFont = isTerminalFont(raw.terminalFont) ? raw.terminalFont : DEFAULT_TERMINAL_FONT;
      s.themePreset = isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal';
      s.windowState = parsePersistedWindowState(raw.windowState);
      s.autoTrustFolders = typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
      s.showPlans = typeof raw.showPlans === 'boolean' ? raw.showPlans : true;
      const rawOpacity = raw.inactiveColumnOpacity;
      s.inactiveColumnOpacity =
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;

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

      // Restore custom agents
      if (Array.isArray(raw.customAgents)) {
        s.customAgents = raw.customAgents.filter(
          (a: unknown): a is AgentDef =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as AgentDef).id === 'string' &&
            typeof (a as AgentDef).name === 'string' &&
            typeof (a as AgentDef).command === 'string',
        );
      }

      // Make custom agents findable during task restoration
      for (const ca of s.customAgents) {
        if (!s.availableAgents.some((a) => a.id === ca.id)) {
          s.availableAgents.push(ca);
        }
      }

      for (const taskId of raw.taskOrder) {
        const pt = raw.tasks[taskId];
        if (!pt) continue;

        const agentId = resolvePersistedAgentId(pt.agentId);
        const agentDef = pt.agentDef;

        // Enrich agent arguments from fresh defaults (handles old state files)
        hydrateAgentDef(agentDef, s.availableAgents, restoredHydraCommand);

        const shellAgentIds = Array.isArray(pt.shellAgentIds)
          ? pt.shellAgentIds.filter(
              (value): value is string => typeof value === 'string' && value.length > 0,
            )
          : [];
        if (shellAgentIds.length === 0) {
          for (let i = 0; i < pt.shellCount; i++) {
            shellAgentIds.push(crypto.randomUUID());
          }
        }

        const task: Task = {
          id: pt.id,
          name: pt.name,
          projectId: pt.projectId ?? '',
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: agentDef ? [agentId] : [],
          shellAgentIds,
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          directMode: pt.directMode,
          skipPermissions: pt.skipPermissions === true,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
        };

        s.tasks[taskId] = task;

        if (agentDef) {
          const agent: Agent = {
            id: agentId,
            taskId,
            def: agentDef,
            resumed: true,
            status: 'running',
            exitCode: null,
            signal: null,
            lastOutput: [],
            generation: 0,
          };
          s.agents[agentId] = agent;
          restoredRunningAgentIds.push(agentId);
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
        const pt = raw.tasks[taskId];
        if (!pt || !pt.collapsed) continue;

        // Enrich agentDef with fresh defaults
        const agentDef = pt.agentDef;
        hydrateAgentDef(agentDef, s.availableAgents, restoredHydraCommand);

        const task: Task = {
          id: pt.id,
          name: pt.name,
          projectId: pt.projectId ?? '',
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: [],
          shellAgentIds: [],
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          directMode: pt.directMode,
          skipPermissions: pt.skipPermissions === true,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
          collapsed: true,
          savedAgentDef: agentDef ?? undefined,
        };

        s.tasks[taskId] = task;
      }
      s.collapsedTaskOrder = collapsedOrder.filter((id) => s.tasks[id]);

      // Defensive: ensure no task appears in both arrays (corrupted state)
      const activeSet = new Set(s.taskOrder);
      s.collapsedTaskOrder = s.collapsedTaskOrder.filter((id) => !activeSet.has(id));

      // Set activeAgentId from the active task
      if (s.activeTaskId && s.tasks[s.activeTaskId]) {
        s.activeAgentId = s.tasks[s.activeTaskId].agentIds[0] ?? null;
      }
    }),
  );

  // Restored agents are considered running; reflect that immediately in task status dots.
  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  syncTerminalCounter();
}
