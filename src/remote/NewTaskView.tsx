import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';

import {
  TASK_CREATION_BRANCH_PREFIX_MAX_UTF8_BYTES,
  TASK_CREATION_GITHUB_URL_MAX_UTF8_BYTES,
  TASK_CREATION_NAME_MAX_UTF8_BYTES,
  canCancelTaskCreation,
  getTaskCreationPhaseLabel,
  type TaskCreationCapabilities,
  type TaskCreationClientFacade,
  type TaskCreationOperationLiveEventSource,
  type TaskCreationPickerItem,
  type TaskCreationOperationSnapshot,
} from '../domain/task-creation';
import { TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES } from '../domain/task-initial-prompt-delivery';
import type { RemoteTaskLocationKind } from '../domain/task-catalog';
import { loadRemoteNewTaskPreferences, saveRemoteNewTaskPreferences } from './new-task-preferences';
import {
  isRemoteTaskCreationCapabilityEnabled,
  validateRemoteNewTaskDraft,
  type RemoteNewTaskFormErrors,
  type RemoteNewTaskFormField,
} from './new-task-form-validation';
import {
  TaskCreationController,
  type RemoteTaskCreationControllerSnapshot,
  type TaskCreationSubmission,
} from './task-creation-controller';
import { remoteTaskCreationOperationLiveEvents } from './task-creation-live-events';
import { remoteTaskCreationFacade } from './remote-task-creation-ipc';
import type { TaskCatalogProjection } from './task-catalog-store';
import './task-experience.css';
import './new-task-view.css';

interface NewTaskViewProps {
  capabilities: TaskCreationCapabilities;
  catalog: TaskCatalogProjection;
  confirm?: (message: string) => boolean;
  facade?: TaskCreationClientFacade;
  liveEvents?: TaskCreationOperationLiveEventSource;
  onBack: () => void;
  onCreated: (taskId: string, snapshot: TaskCreationOperationSnapshot) => void;
}

function getLocationLabel(location: RemoteTaskLocationKind): string {
  switch (location) {
    case 'managed-worktree':
      return 'Managed worktree';
    case 'project-root':
      return 'Project root (shared)';
    case 'existing-worktree':
      return 'Imported worktree (external)';
  }
}

function getActivityLabel(state: RemoteTaskCreationControllerSnapshot): string {
  if (state.operation.snapshot) return getTaskCreationPhaseLabel(state.operation.snapshot);
  if (state.elapsedMs >= 10_000 && state.activity !== 'editing') return 'Still creating…';
  switch (state.activity) {
    case 'editing':
      return 'Ready to create';
    case 'issuing-ticket':
      return 'Securing request…';
    case 'submitting':
      return 'Creating task…';
    case 'checking-status':
      return 'Checking status…';
    case 'cancelling':
      return 'Cancelling…';
    case 'retrying-shell':
      return 'Retrying terminal…';
    case 'tracking':
      return 'Task creation in progress';
  }
}

function isMutable(state: RemoteTaskCreationControllerSnapshot): boolean {
  return state.activity === 'editing' && state.operation.snapshot === null;
}

function shouldShowNewSubmission(snapshot: TaskCreationOperationSnapshot): boolean {
  return (
    snapshot.phase === 'failed-before-commit' ||
    snapshot.phase === 'cancelled-before-preparation' ||
    snapshot.phase === 'manual-reconciliation-required'
  );
}

export function NewTaskView(props: NewTaskViewProps): JSX.Element {
  let agentSelect: HTMLSelectElement | undefined;
  let branchPrefixInput: HTMLInputElement | undefined;
  let existingWorktreeSelect: HTMLSelectElement | undefined;
  let githubUrlInput: HTMLInputElement | undefined;
  let locationSelect: HTMLSelectElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  let projectSelect: HTMLSelectElement | undefined;
  let promptInput: HTMLTextAreaElement | undefined;
  let taskModeGroup: HTMLFieldSetElement | undefined;
  const pickerGenerations = { 'base-branch': 0, 'existing-worktree': 0 };
  let createdNotificationKey: string | null = null;

  const stored = loadRemoteNewTaskPreferences();
  const initial = untrack(() => ({
    catalog: props.catalog,
    capabilities: props.capabilities,
    facade: props.facade ?? remoteTaskCreationFacade,
    liveEvents: props.liveEvents ?? remoteTaskCreationOperationLiveEvents,
  }));
  const firstProjectId = initial.catalog.projects.keys().next().value as string | undefined;
  const firstAgentId = initial.catalog.agents.keys().next().value as string | undefined;
  const initialProjectId =
    stored.projectId && initial.catalog.projects.has(stored.projectId)
      ? stored.projectId
      : (firstProjectId ?? '');
  const initialTaskMode = initial.capabilities.modes.agent.enabled ? 'agent' : 'terminal';
  const initialAgentDefId =
    stored.agentDefId && initial.catalog.agents.has(stored.agentDefId)
      ? stored.agentDefId
      : (firstAgentId ?? '');
  const initialProject = initial.catalog.projects.get(initialProjectId);
  const initialLocation =
    (['managed-worktree', 'project-root', 'existing-worktree'] as const).find((candidate) =>
      isRemoteTaskCreationCapabilityEnabled(
        initial.capabilities.locations[candidate],
        initialProject?.locations[candidate],
      ),
    ) ?? 'managed-worktree';
  const initialBranchPrefixPreference = '';
  const initialStepsTracking = true;
  const initialSkipPermissions = false;
  const initialReuseDependencies = false;
  const [projectId, setProjectId] = createSignal(initialProjectId);
  const [name, setName] = createSignal('');
  const [taskMode, setTaskMode] = createSignal<'agent' | 'terminal'>(initialTaskMode);
  const [agentDefId, setAgentDefId] = createSignal(initialAgentDefId);
  const [location, setLocation] = createSignal<RemoteTaskLocationKind>(initialLocation);
  const [baseBranchRef, setBaseBranchRef] = createSignal('');
  const [existingWorktreeRef, setExistingWorktreeRef] = createSignal('');
  const [branchPrefixPreference, setBranchPrefixPreference] = createSignal(
    initialBranchPrefixPreference,
  );
  const [githubUrl, setGithubUrl] = createSignal('');
  const [initialPrompt, setInitialPrompt] = createSignal('');
  const [stepsTracking, setStepsTracking] = createSignal(initialStepsTracking);
  const [skipPermissions, setSkipPermissions] = createSignal(initialSkipPermissions);
  const [reuseDependencies, setReuseDependencies] = createSignal(initialReuseDependencies);
  const [baseBranches, setBaseBranches] = createSignal<
    Extract<TaskCreationPickerItem, { kind: 'base-branch' }>[]
  >([]);
  const [existingWorktrees, setExistingWorktrees] = createSignal<
    Extract<TaskCreationPickerItem, { kind: 'existing-worktree' }>[]
  >([]);
  const [linkCandidates, setLinkCandidates] = createSignal<string[]>([]);
  const [pickerNotice, setPickerNotice] = createSignal<string | null>(null);
  const [errors, setErrors] = createSignal<RemoteNewTaskFormErrors>({});
  const controller = new TaskCreationController({
    facade: initial.facade,
    liveEvents: initial.liveEvents,
  });
  const [controllerState, setControllerState] = createSignal(controller.getSnapshot());
  const currentProject = createMemo(() => props.catalog.projects.get(projectId()) ?? null);
  const mutable = createMemo(() => isMutable(controllerState()));
  const dirty = createMemo(
    () =>
      name().length > 0 ||
      projectId() !== initialProjectId ||
      taskMode() !== initialTaskMode ||
      agentDefId() !== initialAgentDefId ||
      location() !== initialLocation ||
      baseBranchRef().length > 0 ||
      branchPrefixPreference() !== initialBranchPrefixPreference ||
      initialPrompt().length > 0 ||
      githubUrl().length > 0 ||
      existingWorktreeRef().length > 0 ||
      stepsTracking() !== initialStepsTracking ||
      skipPermissions() !== initialSkipPermissions ||
      reuseDependencies() !== initialReuseDependencies,
  );

  const unsubscribe = controller.subscribe(setControllerState);
  onCleanup(() => {
    pickerGenerations['base-branch'] += 1;
    pickerGenerations['existing-worktree'] += 1;
    unsubscribe();
    controller.dispose();
  });

  onMount(() => {
    void controller.recoverStoredOperation();
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirty() || !mutable()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    onCleanup(() => window.removeEventListener('beforeunload', handleBeforeUnload));
  });

  createEffect(() => {
    if (!props.capabilities.permissionBypass.enabled && skipPermissions()) {
      setSkipPermissions(false);
    }
  });

  createEffect(() => {
    const selectedProject = currentProject();
    if (!selectedProject) return;
    if (
      !isRemoteTaskCreationCapabilityEnabled(
        props.capabilities.locations[location()],
        selectedProject.locations[location()],
      )
    ) {
      const nextLocation = (
        ['managed-worktree', 'project-root', 'existing-worktree'] as const
      ).find((candidate) =>
        isRemoteTaskCreationCapabilityEnabled(
          props.capabilities.locations[candidate],
          selectedProject.locations[candidate],
        ),
      );
      if (nextLocation) {
        setLocation(nextLocation);
        clearErrors('location', 'existingWorktree', 'branchPrefix');
      }
    }
  });

  createEffect(() => {
    const selectedProjectId = projectId();
    if (!selectedProjectId) return;
    void loadPickerPages(selectedProjectId, 'base-branch');
    void loadPickerPages(selectedProjectId, 'existing-worktree');
    void loadLinkCandidates(selectedProjectId);
  });

  createEffect(() => {
    const snapshot = controllerState().operation.snapshot;
    if (
      !snapshot ||
      (snapshot.phase !== 'active' && snapshot.phase !== 'created-needs-attention') ||
      snapshot.current.taskState !== 'present' ||
      !snapshot.current.task
    ) {
      return;
    }
    const notificationKey = `${snapshot.operationId}:${snapshot.version}:${snapshot.current.task.taskId}`;
    if (createdNotificationKey === notificationKey) return;
    createdNotificationKey = notificationKey;
    props.onCreated(snapshot.current.task.taskId, snapshot);
  });

  async function loadPickerPages(
    selectedProjectId: string,
    kind: 'base-branch' | 'existing-worktree',
  ): Promise<void> {
    const generation = ++pickerGenerations[kind];
    const items: TaskCreationPickerItem[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await initial.facade.getPickerPage({
          kind,
          projectId: selectedProjectId,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (generation !== pickerGenerations[kind] || projectId() !== selectedProjectId) return;
        if (
          page.kind !== kind ||
          page.items.some((item) => item.kind !== kind) ||
          items.length + page.items.length > 512
        ) {
          throw new Error('Invalid picker page');
        }
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (page.truncated && cursor === undefined) {
          setPickerNotice(
            'Some choices are hidden. Narrower search support requires the backend picker query.',
          );
        }
      } while (cursor !== undefined);
      if (generation !== pickerGenerations[kind]) return;
      if (kind === 'base-branch') {
        setBaseBranches(items as Extract<TaskCreationPickerItem, { kind: 'base-branch' }>[]);
      } else {
        setExistingWorktrees(
          items as Extract<TaskCreationPickerItem, { kind: 'existing-worktree' }>[],
        );
      }
    } catch {
      if (generation !== pickerGenerations[kind]) return;
      setPickerNotice('Some project choices are temporarily unavailable.');
      if (kind === 'base-branch') setBaseBranches([]);
      else setExistingWorktrees([]);
    }
  }

  async function loadLinkCandidates(selectedProjectId: string): Promise<void> {
    try {
      const result = await initial.facade.getWorktreeLinkCandidates({
        projectId: selectedProjectId,
      });
      if (projectId() !== selectedProjectId) return;
      setLinkCandidates(
        result.kind === 'found'
          ? result.candidates
              .filter((candidate) => candidate.isDefault)
              .map((candidate) => candidate.name)
          : [],
      );
    } catch {
      if (projectId() === selectedProjectId) setLinkCandidates([]);
    }
  }

  function clearErrors(...fields: RemoteNewTaskFormField[]): void {
    setErrors((current) => {
      if (!fields.some((field) => current[field])) return current;
      const fieldsToClear = new Set<RemoteNewTaskFormField>(fields);
      return Object.fromEntries(
        Object.entries(current).filter(
          ([field]) => !fieldsToClear.has(field as RemoteNewTaskFormField),
        ),
      ) as RemoteNewTaskFormErrors;
    });
  }

  function focusFirstError(nextErrors: RemoteNewTaskFormErrors): void {
    const firstField = (Object.keys(nextErrors) as RemoteNewTaskFormField[])[0];
    switch (firstField) {
      case 'project':
        projectSelect?.focus();
        break;
      case 'name':
        nameInput?.focus();
        break;
      case 'taskMode':
        taskModeGroup?.focus();
        break;
      case 'agent':
        agentSelect?.focus();
        break;
      case 'location':
        locationSelect?.focus();
        break;
      case 'existingWorktree':
        existingWorktreeSelect?.focus();
        break;
      case 'prompt':
        promptInput?.focus();
        break;
      case 'branchPrefix':
        branchPrefixInput?.focus();
        break;
      case 'githubUrl':
        githubUrlInput?.focus();
        break;
    }
  }

  function validate(): RemoteNewTaskFormErrors {
    return validateRemoteNewTaskDraft({
      agentAvailable: props.catalog.agents.has(agentDefId()),
      branchPrefixPreference: branchPrefixPreference(),
      capabilities: props.capabilities,
      existingWorktreeRef: existingWorktreeRef(),
      githubUrl: githubUrl(),
      initialPrompt: initialPrompt(),
      location: location(),
      name: name(),
      project: currentProject(),
      taskMode: taskMode(),
    });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!mutable()) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      queueMicrotask(() => focusFirstError(nextErrors));
      return;
    }

    const selectedLocation = location();
    const submission: TaskCreationSubmission = {
      launch:
        taskMode() === 'terminal'
          ? { kind: 'terminal' }
          : {
              agentDefId: agentDefId(),
              initialPrompt: initialPrompt(),
              kind: 'agent',
              skipPermissions: skipPermissions(),
            },
      location:
        selectedLocation === 'managed-worktree'
          ? {
              kind: 'managed-worktree',
              requestedLinkNames: reuseDependencies() ? linkCandidates() : [],
            }
          : selectedLocation === 'project-root'
            ? { kind: 'project-root' }
            : { kind: 'existing-worktree', worktreeRef: existingWorktreeRef() },
      name: name().trim(),
      projectId: projectId(),
      stepsTracking: stepsTracking(),
      ...(currentProject()?.projectMode === 'git' &&
      selectedLocation !== 'project-root' &&
      baseBranchRef()
        ? { baseBranchRef: baseBranchRef() }
        : {}),
      ...(selectedLocation === 'managed-worktree' && branchPrefixPreference().trim()
        ? { branchPrefixPreference: branchPrefixPreference().trim() }
        : {}),
      ...(githubUrl().trim() ? { githubUrl: githubUrl().trim() } : {}),
    };

    saveRemoteNewTaskPreferences({
      ...(agentDefId() ? { agentDefId: agentDefId() } : {}),
      ...(projectId() ? { projectId: projectId() } : {}),
    });
    await controller.submit(submission);
  }

  function requestBack(): void {
    if (
      dirty() &&
      mutable() &&
      !(props.confirm ?? ((message: string) => window.confirm(message)))(
        'Discard this unsaved task draft?',
      )
    ) {
      return;
    }
    props.onBack();
  }

  const operationSnapshot = createMemo(() => controllerState().operation.snapshot);
  const canRetryShell = createMemo(() => {
    const snapshot = operationSnapshot();
    return Boolean(
      snapshot?.taskMode === 'terminal' &&
      snapshot.shellLaunch?.disposition.kind === 'same-tuple-retry' &&
      snapshot.shellLaunch.disposition.retryUntil > Date.now() &&
      snapshot.current.taskState === 'present' &&
      !snapshot.current.taskClosing,
    );
  });
  const cancelableSnapshot = createMemo(() => {
    const snapshot = operationSnapshot();
    return snapshot && canCancelTaskCreation(snapshot) ? snapshot : null;
  });
  const restartableSnapshot = createMemo(() => {
    const snapshot = operationSnapshot();
    return snapshot && shouldShowNewSubmission(snapshot) ? snapshot : null;
  });

  return (
    <main class="task-experience" aria-label="Create task">
      <header class="task-experience__header">
        <button
          aria-label="Back to tasks"
          class="task-experience__button task-experience__button--icon"
          type="button"
          onClick={requestBack}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </button>
        <div class="task-experience__title-group" style={{ flex: '1' }}>
          <h1 class="task-experience__title">New task</h1>
          <p class="task-experience__subtitle">Agent or terminal, without exposing local paths</p>
        </div>
      </header>

      <div class="task-experience__body">
        <Show
          when={controllerState().activity === 'editing' && !operationSnapshot()}
          fallback={<OperationStatus />}
        >
          <form class="new-task-form" novalidate onSubmit={(event) => void submit(event)}>
            <Show when={Object.keys(errors()).length > 0}>
              <div class="new-task-form__error-summary" role="alert" tabindex="-1">
                <strong>Review these fields:</strong>
                <ul>
                  <For each={Object.values(errors())}>{(message) => <li>{message}</li>}</For>
                </ul>
              </div>
            </Show>

            <fieldset class="new-task-form__section" disabled={!mutable()}>
              <legend>Task</legend>
              <div class="new-task-form__field">
                <label class="new-task-form__label" for="new-task-project">
                  Project
                </label>
                <select
                  aria-describedby={errors().project ? 'new-task-project-error' : undefined}
                  aria-invalid={Boolean(errors().project)}
                  class="new-task-form__control"
                  id="new-task-project"
                  ref={projectSelect}
                  value={projectId()}
                  onChange={(event) => {
                    setProjectId(event.currentTarget.value);
                    setBaseBranchRef('');
                    setExistingWorktreeRef('');
                    clearErrors('project', 'location', 'existingWorktree');
                  }}
                >
                  <option value="">Choose a project</option>
                  <For each={[...props.catalog.projects.values()]}>
                    {(project) => <option value={project.id}>{project.label}</option>}
                  </For>
                </select>
                <Show when={errors().project}>
                  {(error) => (
                    <span class="new-task-form__error" id="new-task-project-error">
                      {error()}
                    </span>
                  )}
                </Show>
              </div>

              <div class="new-task-form__field">
                <label class="new-task-form__label" for="new-task-name">
                  Task name
                </label>
                <input
                  aria-describedby={errors().name ? 'new-task-name-error' : undefined}
                  aria-invalid={Boolean(errors().name)}
                  autocomplete="off"
                  class="new-task-form__control"
                  id="new-task-name"
                  maxlength={TASK_CREATION_NAME_MAX_UTF8_BYTES}
                  ref={nameInput}
                  value={name()}
                  onInput={(event) => {
                    setName(event.currentTarget.value);
                    clearErrors('name');
                  }}
                />
                <Show when={errors().name}>
                  {(error) => (
                    <span class="new-task-form__error" id="new-task-name-error">
                      {error()}
                    </span>
                  )}
                </Show>
              </div>
            </fieldset>

            <fieldset
              aria-describedby={errors().taskMode ? 'new-task-mode-error' : undefined}
              aria-invalid={Boolean(errors().taskMode)}
              class="new-task-form__section"
              disabled={!mutable()}
              ref={taskModeGroup}
              tabindex="-1"
            >
              <legend>Run</legend>
              <div class="new-task-form__choice-grid">
                <label class="new-task-form__choice">
                  <input
                    checked={taskMode() === 'agent'}
                    disabled={!props.capabilities.modes.agent.enabled}
                    name="task-mode"
                    type="radio"
                    value="agent"
                    onChange={() => {
                      setTaskMode('agent');
                      clearErrors('taskMode', 'agent', 'prompt');
                    }}
                  />
                  Agent task
                </label>
                <label class="new-task-form__choice">
                  <input
                    checked={taskMode() === 'terminal'}
                    disabled={!props.capabilities.modes.terminal.enabled}
                    name="task-mode"
                    type="radio"
                    value="terminal"
                    onChange={() => {
                      setTaskMode('terminal');
                      clearErrors('taskMode', 'agent', 'prompt');
                    }}
                  />
                  Terminal only
                </label>
              </div>
              <Show when={errors().taskMode}>
                {(error) => (
                  <span class="new-task-form__error" id="new-task-mode-error">
                    {error()}
                  </span>
                )}
              </Show>

              <Show when={taskMode() === 'agent'}>
                <div class="new-task-form__field">
                  <label class="new-task-form__label" for="new-task-agent">
                    Agent
                  </label>
                  <select
                    aria-describedby={errors().agent ? 'new-task-agent-error' : undefined}
                    aria-invalid={Boolean(errors().agent)}
                    class="new-task-form__control"
                    id="new-task-agent"
                    ref={agentSelect}
                    value={agentDefId()}
                    onChange={(event) => {
                      setAgentDefId(event.currentTarget.value);
                      clearErrors('agent');
                    }}
                  >
                    <option value="">Choose an agent</option>
                    <For each={[...props.catalog.agents.values()]}>
                      {(agent) => (
                        <option value={agent.agentDefId}>
                          {agent.displayName}
                          {agent.providerLabel ? ` — ${agent.providerLabel}` : ''}
                        </option>
                      )}
                    </For>
                  </select>
                  <Show when={errors().agent}>
                    {(error) => (
                      <span class="new-task-form__error" id="new-task-agent-error">
                        {error()}
                      </span>
                    )}
                  </Show>
                </div>
                <div class="new-task-form__field">
                  <label class="new-task-form__label" for="new-task-prompt">
                    Initial prompt (optional)
                  </label>
                  <textarea
                    aria-describedby={errors().prompt ? 'new-task-prompt-error' : undefined}
                    aria-invalid={Boolean(errors().prompt)}
                    class="new-task-form__control"
                    id="new-task-prompt"
                    maxlength={TASK_INITIAL_PROMPT_DRAFT_MAX_UTF8_BYTES}
                    ref={promptInput}
                    value={initialPrompt()}
                    onInput={(event) => {
                      setInitialPrompt(event.currentTarget.value);
                      clearErrors('prompt');
                    }}
                  />
                  <Show when={errors().prompt}>
                    {(error) => (
                      <span class="new-task-form__error" id="new-task-prompt-error">
                        {error()}
                      </span>
                    )}
                  </Show>
                </div>
              </Show>
            </fieldset>

            <fieldset class="new-task-form__section" disabled={!mutable()}>
              <legend>Location</legend>
              <div class="new-task-form__field">
                <label class="new-task-form__label" for="new-task-location">
                  Working location
                </label>
                <select
                  aria-describedby={errors().location ? 'new-task-location-error' : undefined}
                  aria-invalid={Boolean(errors().location)}
                  class="new-task-form__control"
                  id="new-task-location"
                  ref={locationSelect}
                  value={location()}
                  onChange={(event) => {
                    setLocation(event.currentTarget.value as RemoteTaskLocationKind);
                    clearErrors('location', 'existingWorktree', 'branchPrefix');
                  }}
                >
                  <For each={['managed-worktree', 'project-root', 'existing-worktree'] as const}>
                    {(candidate) => (
                      <option
                        disabled={
                          !isRemoteTaskCreationCapabilityEnabled(
                            props.capabilities.locations[candidate],
                            currentProject()?.locations[candidate],
                          )
                        }
                        value={candidate}
                      >
                        {getLocationLabel(candidate)}
                      </option>
                    )}
                  </For>
                </select>
                <Show when={errors().location}>
                  {(error) => (
                    <span class="new-task-form__error" id="new-task-location-error">
                      {error()}
                    </span>
                  )}
                </Show>
              </div>

              <Show when={location() === 'existing-worktree'}>
                <div class="new-task-form__field">
                  <label class="new-task-form__label" for="new-task-worktree">
                    Imported worktree
                  </label>
                  <select
                    aria-describedby={
                      errors().existingWorktree
                        ? 'new-task-worktree-hint new-task-worktree-error'
                        : 'new-task-worktree-hint'
                    }
                    aria-invalid={Boolean(errors().existingWorktree)}
                    class="new-task-form__control"
                    id="new-task-worktree"
                    ref={existingWorktreeSelect}
                    value={existingWorktreeRef()}
                    onChange={(event) => {
                      setExistingWorktreeRef(event.currentTarget.value);
                      clearErrors('existingWorktree');
                    }}
                  >
                    <option value="">Choose a worktree</option>
                    <For each={existingWorktrees()}>
                      {(worktree) => (
                        <option value={worktree.ref}>
                          {worktree.label}
                          {worktree.branchLabel ? ` — ${worktree.branchLabel}` : ''}
                        </option>
                      )}
                    </For>
                  </select>
                  <span class="new-task-form__hint" id="new-task-worktree-hint">
                    Imported worktrees are externally owned. Parallel Code will not treat their
                    files as disposable.
                  </span>
                  <Show when={errors().existingWorktree}>
                    {(error) => (
                      <span class="new-task-form__error" id="new-task-worktree-error">
                        {error()}
                      </span>
                    )}
                  </Show>
                </div>
              </Show>

              <Show when={location() === 'managed-worktree' && linkCandidates().length > 0}>
                <label class="new-task-form__choice">
                  <input
                    checked={reuseDependencies()}
                    type="checkbox"
                    onChange={(event) => setReuseDependencies(event.currentTarget.checked)}
                  />
                  Reuse selected project dependencies
                </label>
                <Show when={reuseDependencies()}>
                  <p class="new-task-form__disclosure">
                    Links: {linkCandidates().join(', ')}. Linked entries such as .env may contain
                    secrets. Matching .git/info/exclude entries are append-only and remain after
                    rollback.
                  </p>
                </Show>
              </Show>

              <Show when={currentProject()?.projectMode === 'git' && location() !== 'project-root'}>
                <div class="new-task-form__field">
                  <label class="new-task-form__label" for="new-task-base-branch">
                    Base branch (optional)
                  </label>
                  <select
                    class="new-task-form__control"
                    id="new-task-base-branch"
                    value={baseBranchRef()}
                    onChange={(event) => setBaseBranchRef(event.currentTarget.value)}
                  >
                    <option value="">Project default</option>
                    <For each={baseBranches()}>
                      {(branch) => <option value={branch.ref}>{branch.label}</option>}
                    </For>
                  </select>
                </div>
              </Show>
              <Show when={location() !== 'project-root' && pickerNotice()}>
                {(notice) => (
                  <p aria-live="polite" class="new-task-form__hint" role="status">
                    {notice()}
                  </p>
                )}
              </Show>
            </fieldset>

            <details class="new-task-form__section new-task-form__advanced">
              <summary>Advanced</summary>
              <fieldset class="new-task-form__advanced-content" disabled={!mutable()}>
                <Show when={location() === 'managed-worktree'}>
                  <div class="new-task-form__field">
                    <label class="new-task-form__label" for="new-task-branch-prefix">
                      Branch prefix (optional)
                    </label>
                    <input
                      aria-describedby={
                        errors().branchPrefix ? 'new-task-branch-prefix-error' : undefined
                      }
                      aria-invalid={Boolean(errors().branchPrefix)}
                      class="new-task-form__control"
                      id="new-task-branch-prefix"
                      maxlength={TASK_CREATION_BRANCH_PREFIX_MAX_UTF8_BYTES}
                      ref={branchPrefixInput}
                      value={branchPrefixPreference()}
                      onInput={(event) => {
                        setBranchPrefixPreference(event.currentTarget.value);
                        clearErrors('branchPrefix');
                      }}
                    />
                    <Show when={errors().branchPrefix}>
                      {(error) => (
                        <span class="new-task-form__error" id="new-task-branch-prefix-error">
                          {error()}
                        </span>
                      )}
                    </Show>
                  </div>
                </Show>
                <div class="new-task-form__field">
                  <label class="new-task-form__label" for="new-task-github-url">
                    GitHub URL (optional)
                  </label>
                  <input
                    aria-describedby={errors().githubUrl ? 'new-task-github-url-error' : undefined}
                    aria-invalid={Boolean(errors().githubUrl)}
                    class="new-task-form__control"
                    id="new-task-github-url"
                    inputmode="url"
                    maxlength={TASK_CREATION_GITHUB_URL_MAX_UTF8_BYTES}
                    ref={githubUrlInput}
                    type="url"
                    value={githubUrl()}
                    onInput={(event) => {
                      setGithubUrl(event.currentTarget.value);
                      clearErrors('githubUrl');
                    }}
                  />
                  <Show when={errors().githubUrl}>
                    {(error) => (
                      <span class="new-task-form__error" id="new-task-github-url-error">
                        {error()}
                      </span>
                    )}
                  </Show>
                </div>
                <label class="new-task-form__choice">
                  <input
                    checked={stepsTracking()}
                    type="checkbox"
                    onChange={(event) => setStepsTracking(event.currentTarget.checked)}
                  />
                  Track task steps
                </label>
                <Show when={taskMode() === 'agent'}>
                  <label class="new-task-form__choice">
                    <input
                      checked={skipPermissions()}
                      disabled={!props.capabilities.permissionBypass.enabled}
                      type="checkbox"
                      onChange={(event) => setSkipPermissions(event.currentTarget.checked)}
                    />
                    Bypass agent permission prompts
                  </label>
                  <p class="new-task-form__hint">
                    {props.capabilities.permissionBypass.enabled
                      ? 'Off by default on remote clients. Enable only when you trust the selected agent and project.'
                      : 'Unavailable because this remote session does not have the permission-bypass grant.'}
                  </p>
                </Show>
              </fieldset>
            </details>

            <p class="new-task-form__disclosure">
              <Show
                when={location() === 'project-root'}
                fallback="Creating may start a process and create or modify a worktree and branch."
              >
                <Show
                  when={currentProject()?.projectMode === 'git'}
                  fallback="Project-root tasks share files in this folder, so concurrent edits can overlap."
                >
                  Uses the checked-out branch without switching it. Project-root tasks share files
                  and Git state, so concurrent edits can overlap. Use a worktree for isolation.
                </Show>
              </Show>
            </p>

            <Show when={controllerState().message}>
              {(message) => (
                <div aria-live="polite" class="task-experience__banner" role="status">
                  <strong>{getActivityLabel(controllerState())}</strong>
                  <br />
                  {message()}
                </div>
              )}
            </Show>

            <div class="new-task-form__actions">
              <button class="task-experience__button" type="button" onClick={requestBack}>
                Back to tasks
              </button>
              <button
                class="task-experience__button task-experience__button--primary"
                disabled={!mutable() || !props.capabilities.enabled}
                type="submit"
              >
                {getActivityLabel(controllerState())}
              </button>
            </div>
          </form>
        </Show>
      </div>
    </main>
  );

  function OperationStatus(): JSX.Element {
    const snapshot = createMemo(() => operationSnapshot());
    return (
      <section class="new-task-operation" aria-live="polite" aria-atomic="true">
        <div class="new-task-operation__card">
          <h2 class="new-task-operation__phase">{getActivityLabel(controllerState())}</h2>
          <Show when={controllerState().message}>
            {(message) => <p class="new-task-operation__message">{message()}</p>}
          </Show>
          <Show when={snapshot()?.issue}>
            {(issue) => <p class="new-task-operation__message">{issue().message}</p>}
          </Show>
          <Show when={(snapshot()?.symlinkWarnings.length ?? 0) > 0}>
            <p class="new-task-operation__message">
              {snapshot()?.symlinkWarnings.length} requested dependency link
              {snapshot()?.symlinkWarnings.length === 1 ? '' : 's'} could not be created.
            </p>
          </Show>
          <Show when={snapshot()?.current.taskState === 'removed'}>
            <p class="new-task-operation__message">
              The created task has since been removed. Historical creation status is not current
              task authority.
            </p>
          </Show>
          <Show when={snapshot()?.current.taskState === 'not-visible'}>
            <p class="new-task-operation__message">
              Current task state is not visible. Refresh status before taking another action.
            </p>
          </Show>

          <div class="new-task-operation__actions">
            <Show when={cancelableSnapshot()}>
              <button
                class="task-experience__button"
                disabled={controllerState().activity === 'cancelling'}
                type="button"
                onClick={() => void controller.cancel()}
              >
                Cancel creation
              </button>
            </Show>
            <Show when={canRetryShell()}>
              <button
                class="task-experience__button task-experience__button--primary"
                disabled={controllerState().activity === 'retrying-shell'}
                type="button"
                onClick={() => void controller.retryShell()}
              >
                Retry terminal launch
              </button>
            </Show>
            <Show
              when={
                controllerState().transportOutcomeUnknown ||
                controllerState().elapsedMs >= 60_000 ||
                controllerState().operation.overlay
              }
            >
              <button
                class="task-experience__button"
                disabled={controllerState().activity === 'checking-status'}
                type="button"
                onClick={() => void controller.refreshStatus()}
              >
                Refresh status
              </button>
            </Show>
            <Show when={controllerState().canRetryIdentical}>
              <button
                class="task-experience__button"
                disabled={controllerState().activity !== 'tracking'}
                type="button"
                onClick={() => void controller.retryIdenticalSubmission()}
              >
                Check, then retry same request
              </button>
            </Show>
            <Show when={snapshot()?.current.taskState === 'present' && snapshot()?.current.task}>
              <button
                class="task-experience__button task-experience__button--primary"
                type="button"
                onClick={() => {
                  const current = snapshot();
                  if (current?.current.task) props.onCreated(current.current.task.taskId, current);
                }}
              >
                Open task
              </button>
            </Show>
            <Show when={restartableSnapshot()}>
              <button
                class="task-experience__button"
                type="button"
                onClick={() => controller.startOver()}
              >
                Start a new request
              </button>
            </Show>
            <button class="task-experience__button" type="button" onClick={() => props.onBack()}>
              Continue in background
            </button>
          </div>
        </div>
      </section>
    );
  }
}
