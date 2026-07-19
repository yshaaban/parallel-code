import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { openDialog } from '../lib/dialog';
import {
  store,
  toggleNewTaskDialog,
  getProject,
  getProjectMode,
  getProjectPath,
  getProjectBaseBranch,
  getProjectBranchPrefix,
  updateProject,
  hasCurrentBranchTask,
  getGitHubDropDefaults,
  setPrefillPrompt,
} from '../store/store';
import {
  createTaskOptimistically,
  listPendingTaskCreations,
  type PendingTaskCreation,
} from '../app/task-creation-optimism';
import {
  createCurrentBranchTask,
  createExistingWorktreeTask,
  createTask,
  type TaskLaunch,
} from '../app/task-workflows';
import { sanitizeBranchPrefix, toBranchName } from '../lib/branch-name';
import { cleanTaskName } from '../lib/clean-task-name';
import { parseDirectCommandLine } from '../lib/direct-command';
import { extractGitHubUrl } from '../lib/github-url';
import { isHydraAgentDef } from '../lib/hydra';
import { isElectronRuntime } from '../lib/browser-auth';
import { theme } from '../lib/theme';
import { AgentSelector } from './AgentSelector';
import { BranchPrefixField } from './BranchPrefixField';
import { ProjectSelect } from './ProjectSelect';
import { SectionLabel } from './SectionLabel';
import { SymlinkDirPicker } from './SymlinkDirPicker';
import { typography } from '../lib/typography';
import { getProjectDefaultTaskGitIsolation } from '../store/task-git-isolation';
import type { ProjectMode, TaskGitIsolationMode } from '../store/types';
import type { AgentDef } from '../ipc/types';
import { createTaskGitOptionsController } from './new-task-dialog/task-git-options-controller';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
}

type TaskCreationMode = 'agent' | 'terminal' | 'coordinator';

export function NewTaskDialog(props: NewTaskDialogProps): JSX.Element {
  const titleId = createUniqueId();
  const defaultSkipPermissions = true;
  const [prompt, setPrompt] = createSignal('');
  const [name, setName] = createSignal('');
  const [selectedAgent, setSelectedAgent] = createSignal<AgentDef | null>(null);
  const [customAgentMode, setCustomAgentMode] = createSignal(false);
  const [customAgentCommand, setCustomAgentCommand] = createSignal('');
  const customAgentCommandParseResult = createMemo(() =>
    parseDirectCommandLine(customAgentCommandLine()),
  );
  const [selectedProjectId, setSelectedProjectId] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const [currentBranchMode, setCurrentBranchMode] = createSignal(false);
  const [existingWorktreeMode, setExistingWorktreeMode] = createSignal(false);
  const [existingWorktreePath, setExistingWorktreePath] = createSignal('');
  const [stepsTracking, setStepsTracking] = createSignal(false);
  const [creationMode, setCreationMode] = createSignal<TaskCreationMode>('agent');
  const [skipPermissions, setSkipPermissions] = createSignal(defaultSkipPermissions);
  const [branchPrefix, setBranchPrefix] = createSignal('');
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const defaultTerminalName = createMemo(() => {
    if (!props.open) {
      return 'Terminal';
    }

    const projectId = selectedProjectId();
    if (!projectId) {
      return 'Terminal';
    }

    const reservedNameSlugs = new Set<string>();
    const usedBranches = new Set<string>();
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      const task = store.tasks[taskId];
      if (task?.projectId === projectId) {
        reservedNameSlugs.add(toBranchName(task.name));
        usedBranches.add(task.branchName.trim().toLowerCase());
      }
    }
    for (const pendingTask of listPendingTaskCreations()) {
      if (pendingTask.projectId === projectId) {
        reservedNameSlugs.add(toBranchName(pendingTask.name));
      }
    }

    const prefix = sanitizeBranchPrefix(branchPrefix());
    const candidateIsAvailable = (candidate: string): boolean => {
      const slug = toBranchName(candidate);
      return !reservedNameSlugs.has(slug) && !usedBranches.has(`${prefix}/${slug}`.toLowerCase());
    };

    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? 'Terminal' : `Terminal ${suffix}`;
      if (candidateIsAvailable(candidate)) {
        return candidate;
      }
    }
  });
  const gitOptions = createTaskGitOptionsController({
    branchPreview,
    projectBaseBranch: selectedProjectBaseBranch,
    projectId: selectedProjectId,
    projectMode: selectedProjectMode,
    projectRoot: selectedProjectPath,
  });
  const coordinatorModeAvailable = !isElectronRuntime();
  const terminalMode = () => creationMode() === 'terminal';
  const coordinatorMode = () => creationMode() === 'coordinator';
  let promptRef!: HTMLTextAreaElement;
  let formRef!: HTMLFormElement;

  const focusableSelector =
    'textarea:not(:disabled), input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

  function navigateDialogFields(direction: 'up' | 'down'): void {
    if (!formRef) return;
    const sections = Array.from(formRef.querySelectorAll<HTMLElement>('[data-nav-field]'));
    if (sections.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    const currentIdx = active ? sections.findIndex((s) => s.contains(active)) : -1;

    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 'down' ? 0 : sections.length - 1;
    } else if (direction === 'down') {
      nextIdx = (currentIdx + 1) % sections.length;
    } else {
      nextIdx = (currentIdx - 1 + sections.length) % sections.length;
    }

    const target = sections[nextIdx];
    const focusable = target.querySelector<HTMLElement>(focusableSelector);
    focusable?.focus();
  }

  function navigateWithinField(direction: 'left' | 'right'): void {
    if (!formRef) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;

    const section = active.closest<HTMLElement>('[data-nav-field]');
    if (!section) return;

    const focusables = Array.from(section.querySelectorAll<HTMLElement>(focusableSelector));
    if (focusables.length <= 1) return;

    const idx = focusables.indexOf(active);
    if (idx === -1) return;

    let nextIdx: number;
    if (direction === 'right') {
      nextIdx = (idx + 1) % focusables.length;
    } else {
      nextIdx = (idx - 1 + focusables.length) % focusables.length;
    }
    focusables[nextIdx].focus();
  }

  // Initialize state each time the dialog opens
  createEffect(() => {
    if (!props.open) {
      return;
    }

    // Reset signals for a fresh dialog
    setPrompt('');
    setName('');
    setError('');
    setCustomAgentMode(false);
    setCustomAgentCommand('');
    setCurrentBranchMode(false);
    setExistingWorktreeMode(false);
    setExistingWorktreePath('');
    setStepsTracking(false);
    setCreationMode('agent');
    setSkipPermissions(defaultSkipPermissions);
    gitOptions.reset();
    setAdvancedOpen(false);

    // Dialog open never awaits an agent probe: the catalog is consumed
    // synchronously from the store (probing agents stay launchable) and a
    // throttled backend availability revalidation is fired in the background.
    untrack(() => {
      const launchableAgents = store.availableAgents.filter((agent) => agent.available !== false);
      const lastAgent = store.lastAgentId
        ? (launchableAgents.find((a) => a.id === store.lastAgentId) ?? null)
        : null;
      setSelectedAgent(lastAgent ?? launchableAgents[0] ?? null);

      // Pre-fill from drop data if present
      const dropUrl = store.newTaskDropUrl;
      const fallbackProjectId = store.lastProjectId ?? store.projects[0]?.id ?? null;
      const defaults = dropUrl ? getGitHubDropDefaults(dropUrl) : null;

      if (dropUrl) setPrompt(`review ${dropUrl}`);
      if (defaults) setName(defaults.name);
      setSelectedProjectId(defaults?.projectId ?? fallbackProjectId);

      // Pre-fill from arena comparison prompt
      const prefill = store.newTaskPrefillPrompt;
      if (prefill) {
        setPrompt(prefill.prompt);
        setName('Compare arena results');
        if (prefill.projectId) setSelectedProjectId(prefill.projectId);
      }

      promptRef?.focus();

      const hydraCommand = store.hydraCommand.trim();
      void invoke(IPC.RefreshAgentAvailability, hydraCommand ? { hydraCommand } : undefined).catch(
        () => {},
      );
    });

    // Capture-phase handler for Alt+Arrow to navigate form sections / within fields
    const handleAltArrow = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateDialogFields(e.key === 'ArrowDown' ? 'down' : 'up');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Preserve native word-jump (Alt+Arrow) in text inputs
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateWithinField(e.key === 'ArrowRight' ? 'right' : 'left');
      }
    };
    window.addEventListener('keydown', handleAltArrow, true);

    onCleanup(() => {
      window.removeEventListener('keydown', handleAltArrow, true);
    });
  });

  // Sync branch prefix when project changes
  createEffect(() => {
    const pid = selectedProjectId();
    setBranchPrefix(pid ? getProjectBranchPrefix(pid) : 'task');
  });

  createEffect(() => {
    const pid = selectedProjectId();
    if (!pid) return;
    const proj = getProject(pid);
    if (getProjectMode(proj) === 'non-git') {
      setCurrentBranchMode(false);
      setExistingWorktreeMode(false);
      return;
    }
    if (existingWorktreeMode()) return;
    if (projectRootModeDisabled(pid)) {
      setCurrentBranchMode(false);
      return;
    }
    setCurrentBranchMode(getProjectDefaultTaskGitIsolation(proj) === 'current-branch');
  });

  // Reveal the advanced section when the existing-worktree flow is active so its path picker stays
  // visible instead of hiding behind a collapsed disclosure. This only opens the section; the user
  // can still collapse essentials-only flows manually.
  createEffect(() => {
    if (existingWorktreeMode()) {
      setAdvancedOpen(true);
    }
  });

  function effectiveName(): string {
    const n = name().trim();
    if (n) {
      return n;
    }

    if (terminalMode()) {
      return defaultTerminalName();
    }

    const p = prompt().trim();
    if (!p) {
      if (customAgentMode()) {
        return customAgentCommand().trim();
      }
      return '';
    }

    // Use first line, clean filler phrases, truncate at ~40 chars on word boundary
    const firstLine = cleanTaskName(p.split('\n')[0]);
    if (firstLine.length <= 40) {
      return firstLine;
    }

    return firstLine.slice(0, 40).replace(/\s+\S*$/, '') || firstLine.slice(0, 40);
  }

  function branchPreview(): string {
    const n = effectiveName();
    const prefix = sanitizeBranchPrefix(branchPrefix());
    return n ? `${prefix}/${toBranchName(n)}` : '';
  }

  function selectedProjectPath(): string | undefined {
    const pid = selectedProjectId();
    return pid ? getProjectPath(pid) : undefined;
  }

  function selectedProjectMode(): ProjectMode {
    const pid = selectedProjectId();
    return getProjectMode(pid ? getProject(pid) : null);
  }

  function selectedProjectIsNonGit(): boolean {
    return selectedProjectMode() === 'non-git';
  }

  function selectedProjectBaseBranch(): string | undefined {
    const pid = selectedProjectId();
    return pid ? getProjectBaseBranch(pid) : undefined;
  }

  function currentBranchGuidance(): string {
    const worker = terminalMode() ? 'terminal task' : 'agent';
    if (currentBranchMode()) {
      return 'Reuses the project root without creating a worktree.';
    }

    if (selectedProjectIsNonGit()) {
      return `Starts the ${worker} in this folder without git review or merge features.`;
    }

    if (existingWorktreeMode()) {
      return 'Imports an existing worktree and keeps ownership with you.';
    }

    return `Creates a git branch and worktree so the ${worker} works in isolation.`;
  }

  function currentBranchTooltip(): string {
    return 'Reuses the project root instead of creating a worktree. The backend switches to the selected base branch before starting if needed.';
  }

  function skipPermissionsTooltip(): string {
    return 'Runs without asking for confirmation. The agent can read, write, delete, and execute commands without your approval.';
  }

  function stepsTrackingTooltip(): string {
    if (terminalMode()) {
      return 'Watches .claude/steps.json so the task panel can show durable step history and next-step guidance for this terminal task.';
    }
    return 'Lets the agent maintain .claude/steps.json so the task panel can show durable step history and next-step guidance.';
  }

  function existingWorktreeTooltip(): string {
    return 'Registers an existing git worktree as a task. Closing the task stops its running processes but never deletes that worktree or branch.';
  }

  function currentBranchModeDisabled(): boolean {
    const pid = selectedProjectId();
    return pid ? projectRootModeDisabled(pid) : false;
  }

  function getPendingProjectRootTask(projectId: string): PendingTaskCreation | undefined {
    return listPendingTaskCreations().find(
      (pendingTask) =>
        pendingTask.projectId === projectId && pendingTask.gitIsolation === 'current-branch',
    );
  }

  function projectRootModeDisabled(projectId: string): boolean {
    return hasCurrentBranchTask(projectId) || getPendingProjectRootTask(projectId) !== undefined;
  }

  function projectRootModeDisabledReason(): string {
    const projectId = selectedProjectId();
    if (!projectId) {
      return '';
    }
    if (hasCurrentBranchTask(projectId)) {
      return 'A project-root task already exists for this project.';
    }

    const pendingTask = getPendingProjectRootTask(projectId);
    if (pendingTask?.state.kind === 'creating') {
      return 'A project-root task is already being created for this project.';
    }
    if (pendingTask) {
      return 'Retry or dismiss the pending project-root task before creating another.';
    }
    return '';
  }

  // True when the selected project has no tasks yet, so we can nudge toward working on the current
  // branch directly instead of spinning up an isolated worktree for a first/only task.
  function isFirstTaskForProject(): boolean {
    const pid = selectedProjectId();
    if (!pid) {
      return false;
    }

    return ![...store.taskOrder, ...store.collapsedTaskOrder].some(
      (taskId) => store.tasks[taskId]?.projectId === pid,
    );
  }

  function agentSupportsSkipPermissions(): boolean {
    const agent = selectedAgent();
    return !customAgentMode() && !!agent?.skip_permissions_args?.length && !isHydraAgentDef(agent);
  }

  function skipPermissionsActive(): boolean {
    return agentSupportsSkipPermissions() && skipPermissions();
  }

  function customAgentCommandLine(): string {
    return customAgentCommand().trim();
  }

  function customAgentCommandError(): string | null {
    if (!customAgentMode() || customAgentCommandLine().length === 0) {
      return null;
    }

    const parsed = customAgentCommandParseResult();
    return parsed.ok ? null : parsed.error.message;
  }

  function getCustomAgentName(command: string): string {
    return `Terminal: ${command}`;
  }

  function getCustomAgentId(commandLine: string): string {
    return `custom-command-${commandLine
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64)}`;
  }

  function getSelectedAgentForSubmit(): AgentDef | null {
    if (!customAgentMode()) {
      const agent = selectedAgent();
      return agent && agent.available !== false ? agent : null;
    }

    const parsed = customAgentCommandParseResult();
    if (!parsed.ok) {
      return null;
    }

    const commandLine = customAgentCommandLine();
    const name = getCustomAgentName(commandLine);
    return {
      args: parsed.invocation.args,
      command: parsed.invocation.command,
      description: `Run ${commandLine} in the task terminal.`,
      ...(parsed.invocation.env !== undefined ? { env: parsed.invocation.env } : {}),
      id: getCustomAgentId(commandLine),
      name,
      resume_args: [],
      resume_strategy: 'none',
      skip_permissions_args: [],
    };
  }

  function createsNewWorktree(): boolean {
    return !selectedProjectIsNonGit() && !currentBranchMode() && !existingWorktreeMode();
  }

  function canSubmit(): boolean {
    const hasContent = !!effectiveName();
    const hasLaunchableWorker = terminalMode() || getSelectedAgentForSubmit() !== null;
    const hasRequiredWorktreePath =
      !existingWorktreeMode() || existingWorktreePath().trim().length > 0;
    const canUseSelectedBranch =
      selectedProjectIsNonGit() ||
      (gitOptions.branchListStatus() !== 'loading' && gitOptions.selectedBaseBranchAvailable());
    return (
      hasContent &&
      hasLaunchableWorker &&
      !!selectedProjectId() &&
      hasRequiredWorktreePath &&
      canUseSelectedBranch
    );
  }

  // Count active advanced controls so the collapsed disclosure can hint at important state without
  // forcing the user to expand it.
  function activeAdvancedCount(): number {
    let count = 0;
    if (existingWorktreeMode()) {
      count += 1;
    }
    if (stepsTracking()) {
      count += 1;
    }
    if (!terminalMode() && skipPermissionsActive()) {
      count += 1;
    }
    if (
      !selectedProjectIsNonGit() &&
      gitOptions.selectedBaseBranch() &&
      gitOptions.selectedBaseBranch() !== selectedProjectBaseBranch()
    ) {
      count += 1;
    }
    if (createsNewWorktree() && gitOptions.branchPreviewConflictMessage()) {
      count += 1;
    }
    return count;
  }

  function dialogWidth(): string {
    const needsWideDialog =
      store.availableAgents.length > 8 ||
      currentBranchMode() ||
      existingWorktreeMode() ||
      (!terminalMode() && agentSupportsSkipPermissions());
    return needsWideDialog ? '560px' : '480px';
  }

  async function browseExistingWorktreePath(): Promise<void> {
    const selectedPath = await openDialog({ directory: true, multiple: false });
    if (selectedPath) {
      setExistingWorktreePath(selectedPath);
      updateExistingWorktreeMode(true);
    }
  }

  function updateCurrentBranchMode(enabled: boolean): void {
    setCurrentBranchMode(enabled);
    if (enabled) {
      setExistingWorktreeMode(false);
    }
  }

  function updateExistingWorktreeMode(enabled: boolean): void {
    setExistingWorktreeMode(enabled);
    if (enabled) {
      setCurrentBranchMode(false);
    }
  }

  function selectCreationMode(mode: TaskCreationMode): void {
    setCreationMode(mode);
    setError('');
  }

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const n = effectiveName();
    if (!n) {
      return;
    }

    const isTerminalSubmit = terminalMode();
    const agent = isTerminalSubmit ? null : getSelectedAgentForSubmit();
    if (!isTerminalSubmit && !agent) {
      if (customAgentMode()) {
        const parsed = customAgentCommandParseResult();
        setError(parsed.ok ? 'Enter a command' : parsed.error.message);
      } else {
        setError('Select an available agent');
      }
      return;
    }

    const projectId = selectedProjectId();
    if (!projectId) {
      setError('Select a project');
      return;
    }
    const projectMode = selectedProjectMode();
    let configuredBaseBranch: string | undefined;
    if (projectMode === 'git') {
      configuredBaseBranch = gitOptions.selectedBaseBranchForSubmit();
    }

    if (projectMode === 'git' && !gitOptions.selectedBaseBranchAvailable()) {
      setError('Selected base branch is no longer available. Refresh the branch list.');
      setAdvancedOpen(true);
      return;
    }

    const branchConflict = gitOptions.branchPreviewConflictMessage();
    if (createsNewWorktree() && branchConflict) {
      setError(branchConflict);
      setAdvancedOpen(true);
      return;
    }

    setError('');

    const p = isTerminalSubmit ? undefined : prompt().trim() || undefined;
    const isFromDrop = !!store.newTaskDropUrl;
    const prefix = sanitizeBranchPrefix(branchPrefix());
    const promptGitHubUrl = p ? extractGitHubUrl(p) : undefined;
    const ghUrl = promptGitHubUrl ?? store.newTaskDropUrl ?? undefined;
    const shouldSkipPermissions = skipPermissionsActive();
    // Persist the branch prefix to the project for next time
    if (projectMode === 'git') {
      updateProject(projectId, { branchPrefix: prefix });
    }

    const isCurrentBranchSubmit = currentBranchMode();
    const isExistingWorktreeSubmit = existingWorktreeMode();
    const submitGitIsolation: TaskGitIsolationMode | undefined =
      projectMode === 'non-git'
        ? undefined
        : isCurrentBranchSubmit
          ? 'current-branch'
          : isExistingWorktreeSubmit
            ? 'existing-worktree'
            : 'worktree';
    const submitExistingWorktreePath = existingWorktreePath().trim();
    const submitSymlinkDirs = [...gitOptions.selectedDirs()];
    const submitStepsTracking = stepsTracking();
    const submitCoordinatorMode = coordinatorMode();
    const launch: TaskLaunch | null = isTerminalSubmit
      ? { kind: 'terminal' }
      : agent
        ? {
            kind: 'agent',
            agentDef: agent,
            initialPrompt: isFromDrop ? undefined : p,
            coordinatorMode: submitCoordinatorMode,
            skipPermissions: shouldSkipPermissions,
          }
        : null;
    if (!launch) {
      return;
    }
    const createPendingTask = (): Promise<string> => {
      if (isCurrentBranchSubmit) {
        return createCurrentBranchTask({
          name: n,
          launch,
          projectId,
          ...(configuredBaseBranch ? { baseBranch: configuredBaseBranch } : {}),
          githubUrl: ghUrl,
          stepsTracking: submitStepsTracking,
        });
      }
      if (isExistingWorktreeSubmit) {
        return createExistingWorktreeTask({
          name: n,
          launch,
          projectId,
          existingWorktreePath: submitExistingWorktreePath,
          ...(configuredBaseBranch ? { baseBranch: configuredBaseBranch } : {}),
          githubUrl: ghUrl,
          stepsTracking: submitStepsTracking,
        });
      }
      return createTask({
        name: n,
        launch,
        projectId,
        projectMode,
        symlinkDirs: submitSymlinkDirs,
        ...(configuredBaseBranch ? { baseBranch: configuredBaseBranch } : {}),
        branchPrefixOverride: prefix,
        githubUrl: ghUrl,
        stepsTracking: submitStepsTracking,
      });
    };

    // Optimistic creation: the dialog closes synchronously while the backend
    // round trip runs behind a provisional task column; failures surface on
    // that column with Retry instead of reopening the dialog.
    createTaskOptimistically({
      ...(configuredBaseBranch !== undefined ? { baseBranch: configuredBaseBranch } : {}),
      ...(submitGitIsolation !== undefined ? { gitIsolation: submitGitIsolation } : {}),
      launchLabel: launch.kind === 'terminal' ? 'Terminal' : launch.agentDef.name,
      name: n,
      onCreated: (taskId) => {
        // Drop flow: prefill prompt without auto-sending
        if (!isTerminalSubmit && isFromDrop && p) {
          setPrefillPrompt(taskId, p);
        }
      },
      projectId,
      taskMode: isTerminalSubmit ? 'terminal' : 'agent',
      run: createPendingTask,
    });
    toggleNewTaskDialog(false);
  }

  // Shared visual treatments keep callouts and inputs consistent so the form reads as one
  // surface instead of a stack of bespoke boxes.
  function fieldInputStyle(): JSX.CSSProperties {
    return {
      background: theme.bgInput,
      border: `1px solid ${theme.border}`,
      'border-radius': '8px',
      padding: '8px 11px',
      color: theme.fg,
      outline: 'none',
    };
  }

  function getCalloutColor(tone: 'muted' | 'warning' | 'error'): string {
    switch (tone) {
      case 'error':
        return theme.error;
      case 'warning':
        return theme.warning;
      case 'muted':
        return theme.fgSubtle;
    }
  }

  function calloutStyle(tone: 'muted' | 'warning' | 'error'): JSX.CSSProperties {
    const color = getCalloutColor(tone);
    let background: string;
    let border: string;
    if (tone === 'muted') {
      background = theme.bgElevated;
      border = `1px solid ${theme.border}`;
    } else {
      background = `color-mix(in srgb, ${color} 8%, transparent)`;
      border = `1px solid color-mix(in srgb, ${color} 20%, transparent)`;
    }

    return {
      color,
      background,
      border,
      'border-radius': '8px',
      padding: '6px 10px',
      ...typography.meta,
    };
  }

  function checkboxLabelStyle(disabled = false): JSX.CSSProperties {
    return {
      display: 'flex',
      'align-items': 'center',
      gap: '6px',
      color: disabled ? theme.fgSubtle : theme.fg,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? '0.5' : '1',
      ...typography.meta,
    };
  }

  function isolationSegmentStyle(active: boolean, disabled = false): JSX.CSSProperties {
    return {
      flex: '1',
      padding: '7px 12px',
      'border-radius': '8px',
      background: active ? theme.bgSelected : theme.bgInput,
      border: active ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
      color: theme.fg,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? '0.5' : '1',
      'text-align': 'center',
      ...(active ? typography.uiStrong : typography.ui),
    };
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width={dialogWidth()}
      labelledBy={titleId}
      panelStyle={{ gap: '11px', padding: '20px' }}
    >
      <form
        class="new-task-dialog-form"
        ref={formRef}
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '11px',
        }}
      >
        <DialogHeader
          description={currentBranchGuidance()}
          descriptionTone="muted"
          title="New Task"
          titleId={titleId}
        />

        {/* Prompt - the primary input for agent-backed tasks. */}
        <Show when={!terminalMode()}>
          <div
            data-nav-field="prompt"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
          >
            <SectionLabel as="label">What should the agent work on?</SectionLabel>
            <textarea
              ref={promptRef}
              class="input-field"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (canSubmit()) handleSubmit(e);
                }
              }}
              placeholder="Describe the task, e.g. add user authentication."
              rows={3}
              style={{
                ...fieldInputStyle(),
                ...typography.monoUi,
                resize: 'vertical',
              }}
            />
          </div>
        </Show>

        <div
          data-nav-field="task-mode"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <SectionLabel>Task mode</SectionLabel>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              aria-pressed={creationMode() === 'agent'}
              onClick={() => selectCreationMode('agent')}
              style={isolationSegmentStyle(creationMode() === 'agent')}
            >
              Agent
            </button>
            <button
              type="button"
              aria-pressed={terminalMode()}
              onClick={() => selectCreationMode('terminal')}
              style={isolationSegmentStyle(terminalMode())}
              title="Create a project-backed task with shells and no AI agent"
            >
              Terminal
            </button>
            <button
              type="button"
              aria-pressed={coordinatorMode()}
              disabled={!coordinatorModeAvailable}
              onClick={() => {
                if (coordinatorModeAvailable) selectCreationMode('coordinator');
              }}
              style={isolationSegmentStyle(coordinatorMode(), !coordinatorModeAvailable)}
              title={
                coordinatorModeAvailable
                  ? 'Give this task a compact coordinator rail for hidden subtasks'
                  : 'Coordinator mode runs through the browser server tool gateway'
              }
            >
              Coordinator
            </button>
          </div>
          <Show when={coordinatorMode() && coordinatorModeAvailable}>
            <div style={calloutStyle('muted')}>
              Spawns and tracks hidden background subtasks from a compact coordinator rail.
            </div>
          </Show>
          <Show when={!coordinatorModeAvailable && !terminalMode()}>
            <div style={calloutStyle('muted')}>
              Coordinator mode runs through the browser server tool gateway.
            </div>
          </Show>
        </div>

        <Show when={!terminalMode()}>
          {/* Agent - the second primary choice */}
          <AgentSelector
            agents={store.availableAgents}
            selectedAgent={selectedAgent()}
            onSelect={setSelectedAgent}
          />

          <div
            data-nav-field="custom-agent-command"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
          >
            <label style={checkboxLabelStyle()}>
              <input
                type="checkbox"
                checked={customAgentMode()}
                onChange={(e) => setCustomAgentMode(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
              />
              Use custom command
            </label>
            <Show when={customAgentMode()}>
              <input
                class="input-field"
                type="text"
                value={customAgentCommand()}
                onInput={(e) => {
                  setCustomAgentCommand(e.currentTarget.value);
                  setError('');
                }}
                placeholder="codex"
                style={{
                  ...fieldInputStyle(),
                  ...typography.monoUi,
                }}
              />
              <Show when={customAgentCommandError()}>
                {(message) => <div style={calloutStyle('error')}>{message()}</div>}
              </Show>
              <div style={calloutStyle('muted')}>
                Runs the command directly in the task folder, with any quoted arguments preserved.
              </div>
            </Show>
          </div>
        </Show>

        {/* Project */}
        <div
          data-nav-field="project"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <SectionLabel as="label">Project</SectionLabel>
          <ProjectSelect value={selectedProjectId()} onChange={setSelectedProjectId} />
        </div>

        {/* Task name (optional, derived) + where-it-lands preview */}
        <div
          data-nav-field="task-name"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
        >
          <SectionLabel as="label">
            Task name{' '}
            <span style={{ opacity: '0.5', 'text-transform': 'none' }}>
              {terminalMode() ? '(optional)' : '(optional - derived from prompt)'}
            </span>
          </SectionLabel>
          <input
            class="input-field"
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={
              terminalMode() ? defaultTerminalName() : effectiveName() || 'Add user authentication'
            }
            style={{
              ...fieldInputStyle(),
              ...typography.ui,
            }}
          />
          <Show when={createsNewWorktree() && branchPreview()}>
            <span
              style={{
                ...typography.monoMeta,
                color: theme.fgSubtle,
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '2px 2px 0',
              }}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={{ 'flex-shrink': '0' }}
              >
                <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
              </svg>
              new branch <code>{branchPreview()}</code>
            </span>
          </Show>
          <Show when={currentBranchMode() && selectedProjectPath()}>
            <div
              style={{
                ...typography.monoMeta,
                color: theme.fgSubtle,
                display: 'flex',
                'flex-direction': 'column',
                gap: '2px',
                padding: '4px 2px 0',
              }}
            >
              <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  style={{ 'flex-shrink': '0' }}
                >
                  <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6.25 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 7.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h5.5a2.5 2.5 0 0 0 2.5-2.5v-.5a.75.75 0 0 0-1.5 0v.5a1 1 0 0 1-1 1H5a3.25 3.25 0 1 0 0 6.5h6.25a.75.75 0 0 0 0-1.5H5a1.75 1.75 0 1 1 0-3.5Z" />
                </svg>
                {gitOptions.selectedProjectBaseBranchLabel()}
              </span>
              <span style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  style={{ 'flex-shrink': '0' }}
                >
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                </svg>
                {selectedProjectPath()}
              </span>
            </div>
          </Show>
        </div>

        {/* Isolation - worktree vs current branch (git projects only). */}
        <Show when={!selectedProjectIsNonGit()}>
          <div
            data-nav-field="isolation"
            style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}
          >
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                aria-pressed={createsNewWorktree()}
                title={`Creates a git branch and worktree so the ${terminalMode() ? 'terminal task' : 'agent'} works in isolation without affecting the base branch.`}
                onClick={() => {
                  setCurrentBranchMode(false);
                  setExistingWorktreeMode(false);
                }}
                style={isolationSegmentStyle(createsNewWorktree())}
              >
                New worktree
              </button>
              <button
                type="button"
                aria-pressed={currentBranchMode()}
                disabled={currentBranchModeDisabled()}
                title={currentBranchTooltip()}
                onClick={() => updateCurrentBranchMode(true)}
                style={isolationSegmentStyle(currentBranchMode(), currentBranchModeDisabled())}
              >
                Project root
              </button>
            </div>
            <Show when={currentBranchModeDisabled()}>
              <span style={{ color: theme.fgSubtle, ...typography.meta }}>
                {projectRootModeDisabledReason()}
              </span>
            </Show>
            <Show
              when={!currentBranchModeDisabled() && isFirstTaskForProject() && createsNewWorktree()}
            >
              <span style={{ color: theme.fgSubtle, ...typography.meta }}>
                First task in this project - you can{' '}
                <button
                  type="button"
                  onClick={() => updateCurrentBranchMode(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '0',
                    color: theme.link,
                    cursor: 'pointer',
                    'text-decoration': 'underline',
                    ...typography.meta,
                  }}
                >
                  work in the project root
                </button>{' '}
                instead of creating a worktree.
              </span>
            </Show>
            <Show when={currentBranchMode()}>
              <div style={calloutStyle('warning')}>
                Reuses the project root. The backend switches to the selected base branch before
                starting if needed.
              </div>
            </Show>
          </div>
        </Show>

        {/* Ignored-dir suggestion failures stay visible even when Advanced is collapsed. */}
        <Show when={createsNewWorktree() ? gitOptions.ignoredDirsError() : null}>
          {(message) => (
            <div role="status" aria-live="polite" style={calloutStyle('warning')}>
              Ignored directory suggestions unavailable: {message()}
            </div>
          )}
        </Show>

        <Show when={!terminalMode() && skipPermissionsActive()}>
          <div role="status" aria-live="polite" style={calloutStyle('warning')}>
            Runs without confirmation. The agent can read, write, delete, and execute commands.
          </div>
        </Show>

        {/* Advanced - branch, worktree, permissions, files */}
        <div
          data-nav-field="advanced"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}
        >
          <button
            type="button"
            aria-expanded={advancedOpen()}
            onClick={() => setAdvancedOpen((open) => !open)}
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              padding: '8px 4px',
              background: 'transparent',
              border: 'none',
              'border-top': `1px solid ${theme.border}`,
              color: theme.fgMuted,
              cursor: 'pointer',
              ...typography.metaStrong,
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              style={{
                'flex-shrink': '0',
                transition: 'transform 120ms ease',
                transform: advancedOpen() ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            >
              <path d="M6 4l4 4-4 4V4z" />
            </svg>
            <span>Advanced</span>
            <span style={{ color: theme.fgSubtle, ...typography.meta }}>
              {terminalMode()
                ? 'branch, worktree, steps, files'
                : 'branch, worktree, permissions, files'}
            </span>
            <Show when={!advancedOpen() && activeAdvancedCount() > 0}>
              <span
                style={{
                  'margin-left': 'auto',
                  padding: '1px 7px',
                  'border-radius': '999px',
                  background: `color-mix(in srgb, ${theme.accent} 18%, transparent)`,
                  color: theme.accent,
                  ...typography.label,
                }}
              >
                {activeAdvancedCount()} active
              </span>
            </Show>
          </button>

          <Show when={advancedOpen()}>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '16px',
                'padding-left': '4px',
              }}
            >
              <Show when={selectedProjectPath() && !selectedProjectIsNonGit()}>
                <div
                  data-nav-field="base-branch"
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
                >
                  <SectionLabel as="label">Base branch</SectionLabel>
                  <div
                    style={{
                      display: 'grid',
                      'grid-template-columns': 'minmax(0, 1fr) minmax(180px, 240px)',
                      gap: '8px',
                    }}
                  >
                    <input
                      aria-label="Filter base branches"
                      class="input-field"
                      disabled={gitOptions.branchListStatus() === 'loading'}
                      onInput={(event) => gitOptions.setBranchQuery(event.currentTarget.value)}
                      placeholder="Filter branches"
                      type="text"
                      value={gitOptions.branchQuery()}
                      style={{ ...fieldInputStyle(), padding: '8px 10px', ...typography.monoUi }}
                    />
                    <select
                      aria-label="Base branch"
                      class="input-field"
                      disabled={
                        gitOptions.branchListStatus() === 'loading' ||
                        gitOptions.visibleBranchOptions().length === 0
                      }
                      onChange={(event) =>
                        gitOptions.setSelectedBaseBranch(event.currentTarget.value || null)
                      }
                      value={gitOptions.selectedBaseBranch() ?? ''}
                      style={{ ...fieldInputStyle(), padding: '8px 10px', ...typography.monoUi }}
                    >
                      <For each={gitOptions.visibleBranchOptions()}>
                        {(branch) => (
                          <option value={branch.name}>
                            {gitOptions.formatBranchOption(branch)}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                  <div
                    role="status"
                    aria-live="polite"
                    style={{
                      color:
                        gitOptions.branchListStatus() === 'error' ? theme.warning : theme.fgSubtle,
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      ...typography.meta,
                    }}
                  >
                    <span>{gitOptions.branchPickerStatus()}</span>
                    <Show when={gitOptions.branchListStatus() === 'error'}>
                      <button
                        type="button"
                        class="btn-secondary"
                        onClick={gitOptions.reloadBranches}
                        style={{
                          background: theme.bgInput,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '8px',
                          color: theme.fg,
                          cursor: 'pointer',
                          padding: '4px 8px',
                          ...typography.metaStrong,
                        }}
                      >
                        Retry
                      </button>
                    </Show>
                  </div>
                  <Show when={!gitOptions.selectedBaseBranchAvailable()}>
                    <div role="alert" style={calloutStyle('error')}>
                      Selected base branch is no longer available. Refresh or choose another branch.
                    </div>
                  </Show>
                </div>
              </Show>

              <Show when={createsNewWorktree()}>
                <BranchPrefixField
                  branchPrefix={branchPrefix()}
                  branchPreview={branchPreview()}
                  conflictMessage={gitOptions.branchPreviewConflictMessage()}
                  projectPath={selectedProjectPath()}
                  onPrefixChange={setBranchPrefix}
                />
              </Show>

              <Show when={!selectedProjectIsNonGit()}>
                <div
                  data-nav-field="existing-worktree-mode"
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}
                >
                  <label title={existingWorktreeTooltip()} style={checkboxLabelStyle()}>
                    <input
                      type="checkbox"
                      checked={existingWorktreeMode()}
                      onChange={(e) => updateExistingWorktreeMode(e.currentTarget.checked)}
                      style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
                    />
                    Use existing worktree
                  </label>
                  <Show when={existingWorktreeMode()}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        class="input-field"
                        type="text"
                        value={existingWorktreePath()}
                        onInput={(e) => setExistingWorktreePath(e.currentTarget.value)}
                        placeholder="/path/to/existing/worktree"
                        style={{
                          ...fieldInputStyle(),
                          flex: '1',
                          padding: '8px 10px',
                          ...typography.monoUi,
                        }}
                      />
                      <button
                        type="button"
                        class="btn-secondary"
                        onClick={() => {
                          void browseExistingWorktreePath();
                        }}
                        style={{
                          padding: '8px 12px',
                          background: theme.bgInput,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '8px',
                          color: theme.fg,
                          cursor: 'pointer',
                          ...typography.metaStrong,
                        }}
                      >
                        Browse
                      </button>
                    </div>
                    <div style={calloutStyle('muted')}>
                      Closing this task will keep the selected worktree and branch.
                    </div>
                  </Show>
                </div>
              </Show>

              <div
                data-nav-field="steps-tracking"
                style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}
              >
                <label title={stepsTrackingTooltip()} style={checkboxLabelStyle()}>
                  <input
                    type="checkbox"
                    checked={stepsTracking()}
                    onChange={(e) => setStepsTracking(e.currentTarget.checked)}
                    style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
                  />
                  Track task steps
                </label>
                <Show when={stepsTracking()}>
                  <div style={calloutStyle('muted')}>
                    The backend watches <code>.claude/steps.json</code> and keeps step history
                    shared across clients.
                  </div>
                </Show>
              </div>

              <Show when={!terminalMode() && agentSupportsSkipPermissions()}>
                <div
                  data-nav-field="skip-permissions"
                  style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}
                >
                  <label title={skipPermissionsTooltip()} style={checkboxLabelStyle()}>
                    <input
                      type="checkbox"
                      checked={skipPermissions()}
                      onChange={(e) => setSkipPermissions(e.currentTarget.checked)}
                      style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
                    />
                    Dangerously skip all confirms
                  </label>
                </div>
              </Show>

              <Show when={gitOptions.ignoredDirs().length > 0 && createsNewWorktree()}>
                <SymlinkDirPicker
                  dirs={gitOptions.ignoredDirs()}
                  selectedDirs={gitOptions.selectedDirs()}
                  onToggle={gitOptions.toggleSelectedDir}
                />
              </Show>
            </div>
          </Show>
        </div>

        <Show when={error()}>
          <div style={{ ...calloutStyle('error'), padding: '8px 12px' }}>{error()}</div>
        </Show>

        <div
          data-nav-field="footer"
          style={{
            display: 'flex',
            gap: '8px',
            'justify-content': 'flex-end',
            'padding-top': '4px',
          }}
        >
          <button
            type="button"
            class="btn-secondary"
            onClick={() => props.onClose()}
            style={{
              padding: '9px 18px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fgMuted,
              cursor: 'pointer',
              ...typography.ui,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn-primary"
            disabled={!canSubmit()}
            style={{
              padding: '9px 20px',
              background: theme.accent,
              border: 'none',
              'border-radius': '8px',
              color: theme.accentText,
              cursor: 'pointer',
              opacity: !canSubmit() ? '0.4' : '1',
              display: 'inline-flex',
              'align-items': 'center',
              gap: '8px',
              ...typography.uiStrong,
            }}
          >
            {terminalMode() ? 'Create Terminal Task' : 'Create Task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
