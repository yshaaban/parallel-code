import { randomPastelColor } from './projects';
import type { AppStore, PersistedTask, PersistedWindowState, Project, Task } from './types';
import type { AgentDef } from '../ipc/types';
import { normalizeBaseBranch } from '../lib/base-branch';
import { applyHydraCommandOverride } from '../lib/hydra';
import { removeTerminalStoreState } from './task-state-cleanup';

export interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
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

type HydratedPersistedTaskEntry = ReturnType<typeof buildHydratedTask> & {
  collapsed: boolean;
  taskId: string;
};

function resolvePersistedAgentId(agentId: unknown): string {
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : crypto.randomUUID();
}

function hydrateAgentDef(
  agentDef: AgentDef | null | undefined,
  availableAgents: AgentDef[],
  hydraCommand: string,
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

export function parsePersistedWindowState(v: unknown): PersistedWindowState | null {
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

export function createWorkspaceStateBaseAgents(
  raw: LegacyPersistedState,
  restoredHydraCommand: string,
  currentAvailableAgents: ReadonlyArray<AgentDef>,
  currentCustomAgents: ReadonlyArray<AgentDef>,
): {
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
} {
  const defaultAvailableAgents = currentAvailableAgents.filter(
    (agent) => !currentCustomAgents.some((custom) => custom.id === agent.id),
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

export function parseSharedProjects(raw: LegacyPersistedState): {
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

export function isLegacyPersistedState(raw: unknown): raw is LegacyPersistedState {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as LegacyPersistedState).taskOrder) &&
    typeof (raw as LegacyPersistedState).tasks === 'object'
  );
}

export function buildHydratedTask(
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

export function getPersistedCollapsedTaskOrder(raw: LegacyPersistedState): string[] {
  return raw.collapsedTaskOrder ?? [];
}

export function forEachHydratedPersistedTask(
  raw: LegacyPersistedState,
  options: {
    availableAgents: AgentDef[];
    hydraCommand: string;
    getExistingTask: (taskId: string) => Task | undefined;
    visit: (entry: HydratedPersistedTaskEntry) => void;
  },
): void {
  function visitTask(taskId: string, collapsed: boolean): void {
    const persistedTask = raw.tasks[taskId];
    if (!persistedTask || (collapsed && !persistedTask.collapsed)) {
      return;
    }

    options.visit({
      ...buildHydratedTask(
        persistedTask,
        options.availableAgents,
        options.hydraCommand,
        options.getExistingTask(taskId),
        collapsed,
      ),
      collapsed,
      taskId,
    });
  }

  for (const taskId of raw.taskOrder) {
    visitTask(taskId, false);
  }

  for (const taskId of getPersistedCollapsedTaskOrder(raw)) {
    visitTask(taskId, true);
  }
}

export function restorePersistedTerminals(
  storeState: AppStore,
  raw: LegacyPersistedState,
  options: {
    pruneMissing?: boolean;
    agentsToDelete?: Set<string>;
  } = {},
): void {
  const rawTerminals = (raw.terminals ?? {}) as Record<
    string,
    { id: string; name: string; agentId?: string }
  >;
  if (options.pruneMissing) {
    const activeTerminalIds = new Set(raw.taskOrder);
    for (const existingTerminalId of Object.keys(storeState.terminals)) {
      if (!activeTerminalIds.has(existingTerminalId)) {
        if (options.agentsToDelete) {
          removeTerminalStoreState(storeState, existingTerminalId, {
            agentIdsToDelete: options.agentsToDelete,
          });
        } else {
          removeTerminalStoreState(storeState, existingTerminalId);
        }
      }
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
}

export function syncPersistedTaskVisibility(storeState: AppStore, raw: LegacyPersistedState): void {
  storeState.taskOrder = raw.taskOrder.filter(
    (taskId) => storeState.tasks[taskId] || storeState.terminals[taskId],
  );
  const activeTaskSet = new Set(storeState.taskOrder);
  storeState.collapsedTaskOrder = getPersistedCollapsedTaskOrder(raw).filter(
    (taskId) => storeState.tasks[taskId] && !activeTaskSet.has(taskId),
  );
}
