import {
  Show,
  Suspense,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  type Accessor,
  type JSX,
  type Setter,
} from 'solid-js';

import { openMarkdownViewer } from '../../app/markdown-viewer';
import { sendPrompt } from '../../app/task-workflows';
import { isTerminalTask } from '../../domain/task-mode';
import { lazyNamed } from '../../lib/lazy-named';
import { warn as logWarn } from '../../lib/log';

import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import type { ChangedFile } from '../../ipc/types';
import {
  getProject,
  getSelectedTaskAgentId,
  isAgentAskingQuestion,
  setReviewPanelOpen,
  setTaskFocusedPanel,
  showNotification,
  store,
  updateTaskNotes,
} from '../../store/store';
import { isNonGitProject } from '../../store/project-mode';
import type { Task } from '../../store/types';
import { ChangedFilesList } from '../ChangedFilesList';
import { Dialog } from '../Dialog';
import { IconButton } from '../IconButton';
import type { PanelChild } from '../ResizablePanel';
import { ResizablePanel } from '../ResizablePanel';
import { ScalablePanel } from '../ScalablePanel';

const ReviewPanel = lazyNamed(() => import('../ReviewPanel'), 'ReviewPanel');
const TaskPlanContent = lazyNamed(() => import('./TaskPlanContent'), 'TaskPlanContent');

type TaskNotesTab = 'notes' | 'plan';

interface TaskNotesFilesSectionProps {
  isActive: Accessor<boolean>;
  isHydraTask: Accessor<boolean>;
  notesTab: Accessor<TaskNotesTab>;
  onFileClick: (file: ChangedFile | null) => void;
  setChangedFilesRef: (element: HTMLDivElement | undefined) => void;
  setNotesRef: (element: HTMLTextAreaElement | undefined) => void;
  setPlanFocusRef: (element: HTMLDivElement | undefined) => void;
  setNotesTab: Setter<TaskNotesTab>;
  task: Accessor<Task>;
}

function getNotesTabButtonStyle(tab: TaskNotesTab, selectedTab: TaskNotesTab): JSX.CSSProperties {
  const selected = tab === selectedTab;
  return {
    padding: '2px 8px',
    background: selected ? theme.taskPanelBg : 'transparent',
    color: selected ? theme.fg : theme.fgMuted,
    border: 'none',
    'border-bottom': selected ? `2px solid ${theme.accent}` : '2px solid transparent',
    cursor: 'pointer',
    ...typography.monoMeta,
  };
}

export function createTaskNotesFilesSection(props: TaskNotesFilesSectionProps): PanelChild {
  return {
    id: 'notes-files',
    initialSize: 150,
    minSize: 60,
    content: () => <TaskNotesFilesSection {...props} />,
  };
}

export function TaskNotesFilesSection(props: TaskNotesFilesSectionProps): JSX.Element {
  const fullscreenTitleId = createUniqueId();
  const task = () => props.task();
  const [showFilesFullscreen, setShowFilesFullscreen] = createSignal(false);
  const projectPath = () => getProject(task().projectId)?.path;
  const reviewOpen = () => store.reviewPanelOpen[task().id];
  const filesPanelTitle = () => (reviewOpen() ? 'Review' : 'Changed Files');
  const [sendingNotes, setSendingNotes] = createSignal(false);

  function isPlanVisible(): boolean {
    return props.notesTab() === 'plan' && store.showPlans && Boolean(task().planContent);
  }

  function isNotesVisible(): boolean {
    return props.notesTab() === 'notes' || !store.showPlans || !task().planContent;
  }

  function isInlineChangedFilesVisible(): boolean {
    return !reviewOpen();
  }

  function setInlineChangedFilesRef(element: HTMLDivElement | undefined): void {
    if (!element) {
      props.setChangedFilesRef(undefined);
      return;
    }

    if (isInlineChangedFilesVisible()) {
      props.setChangedFilesRef(element);
    }
  }

  createEffect(() => {
    if (isNotesVisible()) {
      return;
    }

    props.setNotesRef(undefined);
  });

  createEffect(() => {
    if (isInlineChangedFilesVisible()) {
      return;
    }

    props.setChangedFilesRef(undefined);
  });

  onCleanup(() => {
    props.setChangedFilesRef(undefined);
    props.setNotesRef(undefined);
    props.setPlanFocusRef(undefined);
  });

  function closeFilesFullscreen(): void {
    setShowFilesFullscreen(false);
  }

  function openFilesFullscreen(): void {
    setShowFilesFullscreen(true);
  }

  function selectedAiAgentId(): string | undefined {
    const currentTask = task();
    return (
      getSelectedTaskAgentId(
        currentTask,
        store.activeTaskId === currentTask.id ? store.activeAgentId : null,
      ) ?? undefined
    );
  }

  function isNonGitTask(): boolean {
    return isNonGitProject(task());
  }

  async function openPlanViewer(): Promise<void> {
    const currentTask = task();
    const agentId = selectedAiAgentId();
    if (currentTask.planRelativePath && currentTask.worktreePath) {
      const opened = await openMarkdownViewer({
        agentId,
        relativePath: currentTask.planRelativePath,
        taskId: currentTask.id,
        worktreePath: currentTask.worktreePath,
      });
      if (opened) {
        return;
      }
    }

    await openMarkdownViewer({
      agentId,
      content: currentTask.planContent ?? '',
      fileName: currentTask.planFileName,
      relativePath: currentTask.planRelativePath,
      taskId: currentTask.id,
      worktreePath: currentTask.worktreePath,
    });
  }

  function toggleReviewPanel(): void {
    if (isNonGitTask()) {
      return;
    }

    setReviewPanelOpen(task().id, !reviewOpen());
  }

  function getReviewToggleTitle(): string {
    if (isNonGitTask()) {
      return 'Git review is unavailable for non-git projects';
    }

    return reviewOpen() ? 'Show changed files' : 'Open review';
  }

  const notesPromptText = (): string => task().notes.trim();
  const canSendNotes = (): boolean => {
    const agentId = selectedAiAgentId();
    return (
      !sendingNotes() &&
      notesPromptText().length > 0 &&
      agentId !== undefined &&
      !isAgentAskingQuestion(agentId)
    );
  };

  function getSendNotesButtonStyle(): JSX.CSSProperties {
    const enabled = canSendNotes();
    return {
      position: 'absolute',
      right: '6px',
      bottom: '6px',
      width: '24px',
      height: '24px',
      padding: '0',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      background: enabled ? theme.accent : theme.bgInput,
      color: enabled ? theme.accentText : theme.fgMuted,
      border: enabled ? 'none' : `1px solid ${theme.border}`,
      'border-radius': '6px',
      cursor: enabled ? 'pointer' : 'not-allowed',
      opacity: enabled ? '1' : '0.65',
    };
  }

  async function sendNotesAsPrompt(): Promise<void> {
    if (!canSendNotes()) {
      return;
    }

    const agentId = selectedAiAgentId();
    const prompt = notesPromptText();
    if (!agentId || !prompt) {
      return;
    }

    setSendingNotes(true);
    try {
      await sendPrompt(task().id, agentId, prompt);
    } catch (error) {
      logWarn('notes', 'Failed to send notes as prompt', { error });
      showNotification('Failed to send notes to agent');
    } finally {
      setSendingNotes(false);
    }
  }

  function filesOrReviewContent(fullscreen: boolean): JSX.Element {
    if (isNonGitTask()) {
      return (
        <div
          role="status"
          style={{
            color: theme.fgMuted,
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            height: '100%',
            padding: '16px',
            'text-align': 'center',
            ...typography.meta,
          }}
        >
          Git review is unavailable for non-git projects.
        </div>
      );
    }

    return (
      <Show
        when={reviewOpen()}
        fallback={
          <ChangedFilesList
            kind="task"
            taskId={task().id}
            worktreePath={task().worktreePath}
            filterHydraArtifacts={props.isHydraTask()}
            isActive={props.isActive()}
            onFileClick={props.onFileClick}
            setRootRef={fullscreen ? undefined : setInlineChangedFilesRef}
          />
        }
      >
        <Suspense>
          <ReviewPanel
            agentId={selectedAiAgentId()}
            baseBranch={task().baseBranch}
            taskId={task().id}
            worktreePath={task().worktreePath}
            projectRoot={projectPath()}
            branchName={task().branchName}
            filterHydraArtifacts={props.isHydraTask()}
            isActive={props.isActive()}
            fullscreen={fullscreen}
            onOpenFullscreen={openFilesFullscreen}
          />
        </Suspense>
      </Show>
    );
  }

  return (
    <>
      <ResizablePanel
        direction="horizontal"
        persistKey={`task:${task().id}:notes-split`}
        children={[
          {
            id: 'notes',
            initialSize: 200,
            minSize: 100,
            content: () => (
              <ScalablePanel panelId={`${task().id}:notes`}>
                <div
                  class="focusable-panel"
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    'flex-direction': 'column',
                  }}
                  onClick={() => setTaskFocusedPanel(task().id, 'notes')}
                >
                  <Show when={store.showPlans && task().planContent}>
                    <div
                      style={{
                        display: 'flex',
                        'border-bottom': `1px solid ${theme.border}`,
                        'flex-shrink': '0',
                      }}
                    >
                      <button
                        style={getNotesTabButtonStyle('notes', props.notesTab())}
                        onClick={() => props.setNotesTab('notes')}
                      >
                        Notes
                      </button>
                      <button
                        style={getNotesTabButtonStyle('plan', props.notesTab())}
                        onClick={() => props.setNotesTab('plan')}
                      >
                        Plan
                      </button>
                    </div>
                  </Show>

                  <Show when={isNotesVisible()}>
                    <div
                      style={{
                        flex: '1',
                        display: 'flex',
                        'min-height': '0',
                        position: 'relative',
                      }}
                    >
                      <textarea
                        ref={props.setNotesRef}
                        value={task().notes}
                        onInput={(event) => updateTaskNotes(task().id, event.currentTarget.value)}
                        placeholder="Notes..."
                        style={{
                          width: '100%',
                          flex: '1',
                          background: theme.taskPanelBg,
                          border: 'none',
                          padding: '6px 34px 30px 8px',
                          color: theme.fg,
                          resize: 'none',
                          outline: 'none',
                          ...typography.monoUi,
                        }}
                      />
                      <Show when={!isTerminalTask(task())}>
                        <button
                          type="button"
                          aria-label="Send notes as prompt"
                          title="Send notes as prompt"
                          disabled={!canSendNotes()}
                          onClick={() => {
                            void sendNotesAsPrompt();
                          }}
                          style={getSendNotesButtonStyle()}
                        >
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M1.75 2.5a.75.75 0 0 1 .98-.7l11.5 4.75a.75.75 0 0 1 0 1.39l-11.5 4.75a.75.75 0 0 1-1.01-.86L2.72 8 1.72 3.36a.75.75 0 0 1 .03-.86Zm2.05 2.06.52 2.44h4.43a.75.75 0 0 1 0 1.5H4.32L3.8 10.94 12 7.75 3.8 4.56Z" />
                          </svg>
                        </button>
                      </Show>
                    </div>
                  </Show>

                  <Show when={isPlanVisible()}>
                    <Suspense
                      fallback={
                        <div
                          style={{
                            flex: '1',
                            background: theme.taskPanelBg,
                          }}
                        />
                      }
                    >
                      <TaskPlanContent
                        content={task().planContent ?? ''}
                        onOpenPlanViewer={openPlanViewer}
                        setPlanFocusRef={props.setPlanFocusRef}
                      />
                    </Suspense>
                  </Show>
                </div>
              </ScalablePanel>
            ),
          },
          {
            id: 'changed-files',
            initialSize: 200,
            minSize: 100,
            content: () => (
              <ScalablePanel panelId={`${task().id}:changed-files`}>
                <div
                  style={{
                    height: '100%',
                    background: theme.taskPanelBg,
                    display: 'flex',
                    'flex-direction': 'column',
                  }}
                  onClick={() => setTaskFocusedPanel(task().id, 'changed-files')}
                >
                  <div
                    style={{
                      padding: '4px 8px',
                      color: theme.fgMuted,
                      'border-bottom': `1px solid ${theme.border}`,
                      'flex-shrink': '0',
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'space-between',
                      ...typography.label,
                    }}
                  >
                    <span>{filesPanelTitle()}</span>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '4px' }}>
                      <IconButton
                        disabled={isNonGitTask()}
                        size="sm"
                        title={getReviewToggleTitle()}
                        onClick={toggleReviewPanel}
                        icon={
                          reviewOpen() ? (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
                            </svg>
                          ) : (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
                            </svg>
                          )
                        }
                      />
                      <IconButton
                        size="sm"
                        title="Open files fullscreen"
                        onClick={openFilesFullscreen}
                        icon={
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path d="M2.75 2h3.5a.75.75 0 0 1 0 1.5H4.56l2.97 2.97a.75.75 0 1 1-1.06 1.06L3.5 4.56v1.69a.75.75 0 0 1-1.5 0V2.75A.75.75 0 0 1 2.75 2Zm7 0h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V4.56l-2.97 2.97a.75.75 0 0 1-1.06-1.06l2.97-2.97H9.75a.75.75 0 0 1 0-1.5ZM6.47 8.47a.75.75 0 0 1 1.06 1.06L4.56 12.5h1.69a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75v-3.5a.75.75 0 0 1 1.5 0v1.69l2.97-2.97Zm3.06 0 2.97 2.97V9.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.69L8.47 9.53a.75.75 0 1 1 1.06-1.06Z" />
                          </svg>
                        }
                      />
                    </div>
                  </div>
                  <div style={{ flex: '1', overflow: 'hidden' }}>{filesOrReviewContent(false)}</div>
                </div>
              </ScalablePanel>
            ),
          },
        ]}
      />

      <Dialog
        open={showFilesFullscreen()}
        onClose={closeFilesFullscreen}
        width="min(1400px, 96vw)"
        labelledBy={fullscreenTitleId}
        panelStyle={{
          height: '90vh',
          padding: '0',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            height: '100%',
            background: theme.taskPanelBg,
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              'border-bottom': `1px solid ${theme.border}`,
            }}
          >
            <div
              id={fullscreenTitleId}
              style={{
                color: theme.fg,
                ...typography.monoUi,
              }}
            >
              {filesPanelTitle()}
            </div>
            <IconButton
              size="sm"
              title="Close fullscreen"
              onClick={closeFilesFullscreen}
              icon={
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              }
            />
          </div>
          <div style={{ flex: '1', overflow: 'hidden' }}>{filesOrReviewContent(true)}</div>
        </div>
      </Dialog>
    </>
  );
}
