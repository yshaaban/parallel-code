import {
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import {
  clearBusyTaskCommandTakeoverRequest,
  markBusyTaskCommandTakeoverRequest,
  syncBusyTaskCommandTakeoverRequests,
} from '../domain/task-command-takeover-busy-state';
import { getStoredDisplayName, setStoredDisplayName } from '../lib/display-name';
import { lazyNamed } from '../lib/lazy-named';
import { AgentDetail } from './AgentDetail';
import { AgentList } from './AgentList';
import { remoteSessionAllows } from './auth';
import { getRemoteClientId } from './client-id';
import { RemoteSessionNameDialog } from './RemoteSessionNameDialog';
import { RemoteTaskTakeoverDialog } from './RemoteTaskTakeoverDialog';
import {
  clearIncomingRemoteTakeoverRequest,
  getIncomingRemoteTakeoverRequests,
  getRemoteControllingTaskIds,
} from './remote-collaboration';
import { createRemotePresenceRuntime, getDefaultRemoteSessionName } from './remote-presence';
import { respondToRemoteTaskCommandTakeover } from './remote-task-command';
import { agents, authRequired, connect, status } from './ws';
import {
  REMOTE_TASK_CREATION_CAPABILITY_DARK,
  isTaskCreationCapabilities,
  type TaskCreationCapabilities,
  type TaskCreationOperationSnapshot,
} from '../domain/task-creation';
import type { RemoteTaskSessionRef, RemoteTaskSummary } from '../domain/task-catalog';
import type { RemoteTaskExperience } from './remote-task-experience';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import type { TaskCatalogStoreSnapshot } from './task-catalog-store';
import {
  reconcileRemoteTaskNotesCatalogLifecycle,
  type RemoteTaskNotesCatalogLifecycle,
} from './task-notes-lifecycle-channel';

const NewTaskView = lazyNamed(() => import('./NewTaskView'), 'NewTaskView');

interface InitialRemoteSessionState {
  sessionName: string;
  shouldPrompt: boolean;
}

type RemoteTransition = 'none' | 'slide-left' | 'slide-right';

type RemoteView =
  | {
      kind: 'list';
      transition: RemoteTransition;
    }
  | {
      agentId: string;
      kind: 'detail';
      taskName: string;
      transition: RemoteTransition;
    }
  | {
      catalogSeen: boolean;
      fallbackTask?: RemoteTaskSummary;
      kind: 'task-detail';
      taskId: string;
      transition: RemoteTransition;
    }
  | {
      fallbackTask: RemoteTaskSummary;
      kind: 'task-session';
      session: RemoteTaskSessionRef;
      transition: RemoteTransition;
    }
  | { kind: 'new-task'; transition: RemoteTransition };

interface AppProps {
  taskExperience?: RemoteTaskExperience;
}

function getInitialRemoteSessionState(): InitialRemoteSessionState {
  const storedDisplayName = getStoredDisplayName();
  if (storedDisplayName) {
    return {
      sessionName: storedDisplayName,
      shouldPrompt: false,
    };
  }

  return {
    sessionName: getDefaultRemoteSessionName(getRemoteClientId()),
    shouldPrompt: true,
  };
}

export function App(props: AppProps = {}): JSX.Element {
  const [remoteView, setRemoteView] = createSignal<RemoteView>({
    kind: 'list',
    transition: 'none',
  });
  const [sessionName, setSessionName] = createSignal('');
  const [sessionNameDialogOpen, setSessionNameDialogOpen] = createSignal(false);
  const [busyTakeoverRequestIds, setBusyTakeoverRequestIds] = createSignal<Set<string>>(new Set());
  const [catalogSnapshot, setCatalogSnapshot] = createSignal<TaskCatalogStoreSnapshot>(
    props.taskExperience?.catalogRuntime.store.getSnapshot() ?? {
      projection: null,
      revision: 0,
      staleReason: null,
      status: 'empty',
    },
  );
  const [creationCapabilities, setCreationCapabilities] = createSignal<TaskCreationCapabilities>(
    REMOTE_TASK_CREATION_CAPABILITY_DARK,
  );

  const detailView = createMemo(() => {
    const view = remoteView();
    return view.kind === 'detail' ? view : null;
  });
  const taskDetailView = createMemo(() => {
    const view = remoteView();
    return view.kind === 'task-detail' ? view : null;
  });
  const taskSessionView = createMemo(() => {
    const view = remoteView();
    return view.kind === 'task-session' ? view : null;
  });
  const selectedTaskSession = createMemo(() => {
    const view = taskSessionView();
    if (!view) return null;
    return catalogSnapshot().projection?.sessions.get(view.session.sessionId) ?? view.session;
  });
  const selectedCatalogTask = createMemo(() => {
    const view = taskDetailView();
    if (!view) return null;
    return catalogSnapshot().projection?.tasks.get(view.taskId) ?? view.fallbackTask ?? null;
  });
  const selectedTaskNotesLifecycle = createMemo((): RemoteTaskNotesCatalogLifecycle | null => {
    const view = taskDetailView();
    const projection = catalogSnapshot().projection;
    if (!view || !projection) return null;
    const task = projection.tasks.get(view.taskId);
    if (task) {
      return {
        catalogVersion: projection.catalogVersion,
        serverInstanceId: projection.serverInstanceId,
        taskClosing: task.lifecycle === 'closing',
        taskState: 'present',
      };
    }
    if (!view.catalogSeen) return null;
    return {
      catalogVersion: projection.catalogVersion,
      serverInstanceId: projection.serverInstanceId,
      taskClosing: false,
      taskState: 'removed',
    };
  });
  const newTaskCatalog = createMemo(() => {
    if (remoteView().kind !== 'new-task') return null;
    return props.taskExperience ? catalogSnapshot().projection : null;
  });
  const detailAgent = createMemo(() => {
    const view = detailView();
    if (!view) {
      return null;
    }

    return agents().find((agent) => agent.agentId === view.agentId) ?? null;
  });
  const activeTaskId = createMemo(() => {
    return (
      taskDetailView()?.taskId ??
      taskSessionView()?.session.taskId ??
      (detailView() ? (detailAgent()?.taskId ?? null) : null)
    );
  });
  const focusedSurface = createMemo(() =>
    detailView() || taskSessionView() ? 'remote-terminal' : 'remote-list',
  );
  const incomingTakeoverRequests = createMemo(() => getIncomingRemoteTakeoverRequests());

  createRemotePresenceRuntime({
    getActiveTaskId: activeTaskId,
    getConnectionStatus: status,
    getControllingTaskIds: getRemoteControllingTaskIds,
    getDisplayName: sessionName,
    getFocusedSurface: focusedSurface,
  });

  function clearBusyTakeoverRequest(requestId: string): void {
    setBusyTakeoverRequestIds((currentRequestIds) =>
      clearBusyTaskCommandTakeoverRequest(currentRequestIds, requestId),
    );
  }

  function markBusyTakeoverRequest(requestId: string): void {
    setBusyTakeoverRequestIds((currentRequestIds) =>
      markBusyTaskCommandTakeoverRequest(currentRequestIds, requestId),
    );
  }

  createEffect(() => {
    const currentRequestIds = new Set(
      incomingTakeoverRequests().map((request) => request.requestId),
    );
    setBusyTakeoverRequestIds((currentBusyRequestIds) =>
      syncBusyTaskCommandTakeoverRequests(currentBusyRequestIds, currentRequestIds),
    );
  });

  createEffect(() => {
    const view = taskDetailView();
    const projection = catalogSnapshot().projection;
    if (!view || !projection) {
      return;
    }
    if (projection.tasks.has(view.taskId)) {
      if (!view.catalogSeen) {
        setRemoteView((current) =>
          current.kind === 'task-detail' && current.taskId === view.taskId
            ? { ...current, catalogSeen: true }
            : current,
        );
      }
      return;
    }
    if (!view.catalogSeen) return;

    const taskId = view.taskId;
    const lifecycle: RemoteTaskNotesCatalogLifecycle = {
      catalogVersion: projection.catalogVersion,
      serverInstanceId: projection.serverInstanceId,
      taskClosing: false,
      taskState: 'removed',
    };
    if (reconcileRemoteTaskNotesCatalogLifecycle(taskId, lifecycle)) return;
    setRemoteView((current) =>
      current.kind === 'task-detail' && current.taskId === taskId
        ? { kind: 'list', transition: 'slide-left' }
        : current,
    );
  });

  function selectAgent(id: string, name: string): void {
    setRemoteView({
      agentId: id,
      kind: 'detail',
      taskName: name,
      transition: 'slide-right',
    });
  }

  function showList(): void {
    setRemoteView({ kind: 'list', transition: 'slide-left' });
  }

  function selectTask(taskId: string): void {
    const task = catalogSnapshot().projection?.tasks.get(taskId);
    if (!task) return;
    setRemoteView({
      catalogSeen: true,
      fallbackTask: Object.freeze({ ...task }),
      kind: 'task-detail',
      taskId,
      transition: 'slide-right',
    });
  }

  function openNewTask(): void {
    if (!props.taskExperience || !creationCapabilities().enabled) return;
    setRemoteView({ kind: 'new-task', transition: 'slide-right' });
  }

  function openTaskSession(session: RemoteTaskSessionRef): boolean {
    const projection = catalogSnapshot().projection;
    const catalogSession = projection?.sessions.get(session.sessionId);
    const task = catalogSession ? projection?.tasks.get(catalogSession.taskId) : undefined;
    if (
      !catalogSession ||
      !task ||
      !remoteSessionAllows('terminal.attach') ||
      !remoteSessionAllows('terminal.detach')
    ) {
      return false;
    }
    setRemoteView({
      kind: 'task-session',
      fallbackTask: Object.freeze({ ...task }),
      session: Object.freeze({ ...catalogSession }),
      transition: 'slide-right',
    });
    return true;
  }

  function closeTaskSession(): void {
    const current = taskSessionView();
    if (!current) return;
    setRemoteView({
      catalogSeen: true,
      fallbackTask: current.fallbackTask,
      kind: 'task-detail',
      taskId: current.session.taskId,
      transition: 'slide-left',
    });
  }

  function openCreatedTask(taskId: string, snapshot: TaskCreationOperationSnapshot): void {
    const fallbackTask =
      snapshot.current.task?.taskId === taskId ? snapshot.current.task : undefined;
    setRemoteView({
      ...(fallbackTask ? { fallbackTask } : {}),
      catalogSeen: Boolean(catalogSnapshot().projection?.tasks.has(taskId)),
      kind: 'task-detail',
      taskId,
      transition: 'slide-left',
    });
  }

  function openSessionNameDialog(): void {
    setSessionNameDialogOpen(true);
  }

  function saveSessionName(nextValue: string): void {
    setSessionName(setStoredDisplayName(nextValue));
    setSessionNameDialogOpen(false);
  }

  async function handleTakeoverResponse(requestId: string, approved: boolean): Promise<void> {
    markBusyTakeoverRequest(requestId);
    const handled = await respondToRemoteTaskCommandTakeover(requestId, approved).catch(
      () => false,
    );
    if (!handled) {
      clearBusyTakeoverRequest(requestId);
    }
  }

  onMount(() => {
    const initialSessionState = getInitialRemoteSessionState();
    setSessionName(initialSessionState.sessionName);
    setSessionNameDialogOpen(initialSessionState.shouldPrompt);
    connect();

    const experience = props.taskExperience;
    if (!experience) return;
    const abortController = new AbortController();
    const unsubscribeCatalog = experience.catalogRuntime.store.subscribe(setCatalogSnapshot);
    void experience.catalogRuntime.requestResync();
    void experience.creationCapabilities
      .getCapabilities(abortController.signal)
      .then((capabilities) => {
        if (isTaskCreationCapabilities(capabilities)) setCreationCapabilities(capabilities);
      })
      .catch(() => setCreationCapabilities(REMOTE_TASK_CREATION_CAPABILITY_DARK));
    onCleanup(() => {
      abortController.abort();
      unsubscribeCatalog();
      experience.catalogRuntime.dispose();
    });
  });

  createEffect(
    on(status, (nextStatus, previousStatus) => {
      const runtime = props.taskExperience?.catalogRuntime;
      if (!runtime) return;
      if (nextStatus === 'connected') {
        if (previousStatus && previousStatus !== 'connected') void runtime.requestResync();
      } else if (nextStatus === 'reconnecting' || nextStatus === 'disconnected') {
        runtime.handleConnectionLoss();
      }
    }),
  );

  return (
    <Show
      when={!authRequired()}
      fallback={
        <div class="remote-auth-required">
          <div class="remote-auth-required__content">
            <div class="remote-auth-required__icon">
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"
                  stroke="var(--text-muted)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </div>
            <p class="remote-auth-required__title">Not authenticated</p>
            <p class="remote-auth-required__help">
              Open the shared browser link again or rescan the QR code from Parallel Code.
            </p>
          </div>
        </div>
      }
    >
      <div class="remote-shell">
        <div class="remote-shell__glow remote-shell__glow--left" />
        <div class="remote-shell__glow remote-shell__glow--right" />
        <div class="remote-shell__grid" />
        <div
          class="remote-shell__view"
          data-transition={remoteView().transition}
          onAnimationEnd={() =>
            setRemoteView((view) => ({
              ...view,
              transition: 'none',
            }))
          }
        >
          <Switch
            fallback={
              <AgentList
                onEditSessionName={openSessionNameDialog}
                onSelect={selectAgent}
                sessionName={sessionName()}
              />
            }
          >
            <Match when={detailView()}>
              {(view) => (
                <AgentDetail
                  agentId={view().agentId}
                  taskName={view().taskName}
                  onBack={showList}
                />
              )}
            </Match>
            <Match when={selectedCatalogTask()}>
              {(task) => (
                <TaskDetail
                  onBack={showList}
                  onOpenSession={openTaskSession}
                  project={catalogSnapshot().projection?.projects.get(task().projectId) ?? null}
                  sessions={catalogSnapshot().projection?.sessionsByTask.get(task().taskId) ?? []}
                  task={task()}
                  taskNotesCapability={props.taskExperience?.taskNotesCapability}
                  taskNotesLifecycle={selectedTaskNotesLifecycle()}
                />
              )}
            </Match>
            <Match when={selectedTaskSession()}>
              {(session) => (
                <AgentDetail
                  agentId={session().sessionId}
                  taskName={taskSessionView()?.fallbackTask.name ?? ''}
                  taskNotesCapability={props.taskExperience?.taskNotesCapability}
                  taskSession={session()}
                  terminalControl={
                    remoteSessionAllows('terminal.input') && remoteSessionAllows('terminal.resize')
                  }
                  terminalKill={remoteSessionAllows('terminal.kill')}
                  onBack={closeTaskSession}
                />
              )}
            </Match>
            <Match when={newTaskCatalog()}>
              {(catalog) => (
                <Suspense
                  fallback={
                    <div class="task-experience task-experience__empty" role="status">
                      Loading task creation…
                    </div>
                  }
                >
                  <NewTaskView
                    capabilities={creationCapabilities()}
                    catalog={catalog()}
                    onBack={showList}
                    onCreated={openCreatedTask}
                  />
                </Suspense>
              )}
            </Match>
            <Match when={props.taskExperience}>
              <TaskList
                canCreate={creationCapabilities().enabled && catalogSnapshot().status === 'ready'}
                catalog={catalogSnapshot()}
                connectionStatus={status()}
                onCreate={openNewTask}
                onEditSessionName={openSessionNameDialog}
                onSelectTask={selectTask}
                sessionName={sessionName()}
              />
            </Match>
          </Switch>
        </div>
      </div>

      <RemoteSessionNameDialog
        initialValue={sessionName()}
        onSave={saveSessionName}
        open={sessionNameDialogOpen()}
      />
      <RemoteTaskTakeoverDialog
        busyRequestIds={busyTakeoverRequestIds()}
        onApprove={(requestId) => {
          void handleTakeoverResponse(requestId, true);
        }}
        onDeny={(requestId) => {
          void handleTakeoverResponse(requestId, false);
        }}
        onExpire={(requestId) => {
          clearIncomingRemoteTakeoverRequest(requestId);
          clearBusyTakeoverRequest(requestId);
        }}
        requests={incomingTakeoverRequests()}
      />
    </Show>
  );
}
