import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
  type JSX,
} from 'solid-js';

import type { TaskNotesCapability } from '../app/task-notes-capability';
import type { RemoteTaskNotesCatalogLifecycle } from './task-notes-runtime';
import type {
  RemoteProjectSummary,
  RemoteTaskSessionRef,
  RemoteTaskSummary,
} from '../domain/task-catalog';
import { lazyNamed } from '../lib/lazy-named';
import { TaskLocationChip } from './TaskLocationChip';
import './task-experience.css';

const TaskNotesView = lazyNamed(() => import('./TaskNotesView'), 'TaskNotesView');

type TaskDetailTab = 'sessions' | 'notes';

interface TaskDetailProps {
  confirm?: (message: string) => boolean;
  onBack: () => void;
  onOpenSession: (session: RemoteTaskSessionRef) => boolean;
  project: RemoteProjectSummary | null;
  sessions: readonly RemoteTaskSessionRef[];
  task: RemoteTaskSummary;
  taskNotesLifecycle?: RemoteTaskNotesCatalogLifecycle | null;
  taskNotesCapability?: TaskNotesCapability;
}

function getSessionLabel(session: RemoteTaskSessionRef, index: number): string {
  if (session.kind === 'shell') return index === 0 ? 'Terminal' : `Terminal ${index + 1}`;
  return index === 0 ? 'Agent session' : `Agent session ${index + 1}`;
}

function getSessionStateClass(state: RemoteTaskSessionRef['state']): string {
  if (state === 'running') return 'task-status-dot task-status-dot--running';
  if (state === 'failed') return 'task-status-dot task-status-dot--failed';
  return 'task-status-dot';
}

function formatSessionState(state: RemoteTaskSessionRef['state']): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'stopped':
      return 'Stopped';
    case 'failed':
      return 'Failed';
    case 'not-started':
      return 'Not started';
  }
}

export function TaskDetail(props: TaskDetailProps): JSX.Element {
  let heading: HTMLHeadingElement | undefined;
  let sessionsTab: HTMLButtonElement | undefined;
  let notesTab: HTMLButtonElement | undefined;
  const [activeTab, setActiveTab] = createSignal<TaskDetailTab>('sessions');
  const [navigationPending, setNavigationPending] = createSignal(false);
  const [sessionNotice, setSessionNotice] = createSignal<string | null>(null);
  const modeLabel = createMemo(() =>
    props.task.taskMode === 'terminal' ? 'Terminal-only task' : 'Agent task',
  );

  onMount(() => heading?.focus());

  createEffect(
    on(
      () => props.task.taskId,
      () => {
        setActiveTab('sessions');
        setSessionNotice(null);
      },
      { defer: true },
    ),
  );

  const notesAvailable = () => props.taskNotesCapability?.read === true;

  async function leaveNotes(action: () => void): Promise<boolean> {
    if (navigationPending()) return false;
    if (activeTab() !== 'notes') {
      action();
      return true;
    }

    setNavigationPending(true);
    try {
      const runtime = await import('./TaskNotesView');
      const confirmDiscard = props.confirm ?? ((message: string) => window.confirm(message));
      if (
        !(await runtime.confirmRemoteTaskNotesLeave(
          props.task.taskId,
          'Discard the unsaved notes draft and leave this task?',
          confirmDiscard,
        ))
      ) {
        return false;
      }
      action();
      return true;
    } catch {
      setSessionNotice(
        'Notes draft status could not be checked. Try again before leaving the task.',
      );
      return false;
    } finally {
      setNavigationPending(false);
    }
  }

  async function selectTab(tab: TaskDetailTab): Promise<boolean> {
    if (tab === activeTab()) return true;
    if (tab === 'notes' && !notesAvailable()) return false;
    if (tab === 'sessions') {
      return leaveNotes(() => setActiveTab('sessions'));
    }
    setSessionNotice(null);
    setActiveTab('notes');
    return true;
  }

  function handleTabKeyDown(event: KeyboardEvent): void {
    const tabs: TaskDetailTab[] = notesAvailable() ? ['sessions', 'notes'] : ['sessions'];
    const currentIndex = tabs.indexOf(activeTab());
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    void selectTab(nextTab).then((selected) => {
      if (!selected) return;
      requestAnimationFrame(() => (nextTab === 'notes' ? notesTab : sessionsTab)?.focus());
    });
  }

  function openSession(session: RemoteTaskSessionRef): void {
    const onOpenSession = props.onOpenSession;
    const unavailableMessage =
      session.kind === 'shell'
        ? 'This terminal session could not be attached. Refresh the task catalog and try again.'
        : 'This agent session is no longer present in the terminal stream. Refresh the task catalog and try again.';
    void leaveNotes(() => {
      setSessionNotice(null);
      if (!onOpenSession(session)) setSessionNotice(unavailableMessage);
    });
  }

  return (
    <main class="task-experience" aria-label={`Task ${props.task.name}`}>
      <header class="task-experience__header">
        <button
          aria-label="Back to tasks"
          class="task-experience__button task-experience__button--icon"
          type="button"
          disabled={navigationPending()}
          onClick={() => void leaveNotes(props.onBack)}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </button>
        <div class="task-experience__title-group" style={{ flex: '1' }}>
          <h1 class="task-experience__title" ref={heading} tabindex="-1">
            {props.task.name}
          </h1>
          <p class="task-experience__subtitle">{props.project?.label ?? 'Project unavailable'}</p>
        </div>
        <span
          aria-label={`${props.sessions.length} ${props.sessions.length === 1 ? 'session' : 'sessions'}`}
          class="task-chip"
        >
          {props.sessions.length}
        </span>
      </header>

      <div
        aria-label="Task detail"
        class="task-detail__tabs"
        role="tablist"
        onKeyDown={handleTabKeyDown}
      >
        <button
          aria-controls="task-sessions-panel"
          aria-selected={activeTab() === 'sessions'}
          class="task-detail__tab"
          id="task-sessions-tab"
          ref={sessionsTab}
          role="tab"
          tabindex={activeTab() === 'sessions' ? 0 : -1}
          type="button"
          onClick={() => void selectTab('sessions')}
        >
          Sessions
        </button>
        <Show when={notesAvailable()}>
          <button
            aria-controls="task-notes-panel"
            aria-selected={activeTab() === 'notes'}
            class="task-detail__tab"
            id="task-notes-tab"
            ref={notesTab}
            role="tab"
            tabindex={activeTab() === 'notes' ? 0 : -1}
            type="button"
            onClick={() => void selectTab('notes')}
          >
            Notes
          </button>
        </Show>
      </div>

      <div class="task-experience__body">
        <section class="task-detail__summary" aria-label="Task summary">
          <div class="task-card__meta" style={{ margin: '0' }}>
            <span class="task-chip task-chip--accent">{modeLabel()}</span>
            <TaskLocationChip task={props.task} />
            <Show when={props.task.lifecycle === 'closing'}>
              <span class="task-chip task-chip--warning">Closing</span>
            </Show>
            <Show when={props.task.creationStatus === 'failed'}>
              <span class="task-chip task-chip--danger">Creation failed</span>
            </Show>
            <Show when={props.task.creationStatus === 'needs-attention'}>
              <span class="task-chip task-chip--warning">Needs attention</span>
            </Show>
          </div>
          <Show when={props.task.location !== 'project-root' && props.task.branchLabel}>
            {(branch) => <p class="task-experience__subtitle">Branch: {branch()}</p>}
          </Show>
        </section>

        <section
          aria-labelledby="task-sessions-tab"
          id="task-sessions-panel"
          role="tabpanel"
          hidden={activeTab() !== 'sessions'}
        >
          <h2 class="task-detail__section-title" id="task-sessions-title">
            Sessions
          </h2>
          <Show
            when={props.sessions.length > 0}
            fallback={
              <div class="task-experience__empty">
                {props.task.creationStatus === 'starting'
                  ? 'The first session is still starting.'
                  : 'This task has no session. It remains visible so failures and stopped work are not lost.'}
              </div>
            }
          >
            <ul class="task-session-list">
              <For each={props.sessions}>
                {(session, index) => (
                  <li>
                    <button
                      aria-label={`Open ${getSessionLabel(session, index())}. ${formatSessionState(session.state)}.`}
                      class="task-session-card"
                      disabled={props.task.lifecycle === 'closing' || navigationPending()}
                      type="button"
                      onClick={() => openSession(session)}
                    >
                      <span class="task-session-card__top">
                        <span class="task-session-card__name">
                          {getSessionLabel(session, index())}
                        </span>
                        <span aria-hidden="true" class={getSessionStateClass(session.state)} />
                      </span>
                      <span class="task-session-card__meta">
                        <span class="task-chip">{formatSessionState(session.state)}</span>
                        <span class="task-chip">Generation {session.generation}</span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <Show when={notesAvailable() && activeTab() === 'notes'}>
          <section aria-labelledby="task-notes-tab" id="task-notes-panel" role="tabpanel">
            <Suspense
              fallback={
                <div class="task-experience__empty" role="status">
                  Loading notes…
                </div>
              }
            >
              <TaskNotesView
                canWrite={props.taskNotesCapability?.write === true}
                lifecycle={props.taskNotesLifecycle}
                taskId={props.task.taskId}
                taskName={props.task.name}
                onChooseAnotherTask={() => void leaveNotes(props.onBack)}
              />
            </Suspense>
          </section>
        </Show>

        <Show when={sessionNotice()}>
          {(notice) => (
            <div
              aria-live="polite"
              aria-atomic="true"
              class="task-experience__banner task-experience__banner--warning"
              role="status"
              style={{ 'margin-top': 'var(--space-md)' }}
            >
              {notice()}
            </div>
          )}
        </Show>
      </div>
    </main>
  );
}
