import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type Accessor,
  type JSX,
  type Setter,
} from 'solid-js';

import { openMarkdownViewer } from '../../app/markdown-viewer';
import { sendPrompt } from '../../app/task-workflows';
import { warn as logWarn } from '../../lib/log';
import { renderMarkdownSafely } from '../../lib/marked-shiki';

import { createDialogScroll } from '../../lib/dialog-scroll';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import type { ChangedFile } from '../../ipc/types';
import {
  getProject,
  isAgentAskingQuestion,
  setReviewPanelOpen,
  setTaskFocusedPanel,
  showNotification,
  store,
  updateTaskNotes,
} from '../../store/store';
import type { Task } from '../../store/types';
import { ChangedFilesList } from '../ChangedFilesList';
import { Dialog } from '../Dialog';
import { IconButton } from '../IconButton';
import type { PanelChild } from '../ResizablePanel';
import { ResizablePanel } from '../ResizablePanel';
import { ReviewPanel } from '../ReviewPanel';
import { ScalablePanel } from '../ScalablePanel';

interface TaskNotesFilesSectionProps {
  isActive: Accessor<boolean>;
  isHydraTask: Accessor<boolean>;
  notesTab: Accessor<'notes' | 'plan'>;
  onFileClick: (file: ChangedFile | null) => void;
  setChangedFilesRef: (element: HTMLDivElement | undefined) => void;
  setNotesRef: (element: HTMLTextAreaElement | undefined) => void;
  setPlanFocusRef: (element: HTMLDivElement | undefined) => void;
  setNotesTab: Setter<'notes' | 'plan'>;
  task: Accessor<Task>;
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
  const planHtml = createMemo(() => renderMarkdownSafely(task().planContent ?? ''));
  const [sendingNotes, setSendingNotes] = createSignal(false);
  let planContentRef: HTMLDivElement | undefined;

  function isPlanVisible(): boolean {
    return props.notesTab() === 'plan' && store.showPlans && Boolean(task().planContent);
  }

  createDialogScroll({
    enabled: isPlanVisible,
    getElement: () => planContentRef,
  });

  createEffect(() => {
    if (isPlanVisible()) {
      return;
    }

    planContentRef = undefined;
    props.setPlanFocusRef(undefined);
  });

  function closeFilesFullscreen(): void {
    setShowFilesFullscreen(false);
  }

  function openFilesFullscreen(): void {
    setShowFilesFullscreen(true);
  }

  async function openPlanViewer(): Promise<void> {
    const currentTask = task();
    if (currentTask.planRelativePath && currentTask.worktreePath) {
      const opened = await openMarkdownViewer({
        agentId: currentTask.agentIds[0],
        relativePath: currentTask.planRelativePath,
        taskId: currentTask.id,
        worktreePath: currentTask.worktreePath,
      });
      if (opened) {
        return;
      }
    }

    await openMarkdownViewer({
      agentId: currentTask.agentIds[0],
      content: currentTask.planContent ?? '',
      fileName: currentTask.planFileName,
      relativePath: currentTask.planRelativePath,
      taskId: currentTask.id,
      worktreePath: currentTask.worktreePath,
    });
  }

  function toggleReviewPanel(): void {
    setReviewPanelOpen(task().id, !reviewOpen());
  }

  const notesPromptText = (): string => task().notes.trim();
  const primaryAgentId = (): string | undefined => task().agentIds[0];
  const canSendNotes = (): boolean => {
    const agentId = primaryAgentId();
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

    const agentId = primaryAgentId();
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
            ref={props.setChangedFilesRef}
          />
        }
      >
        <ReviewPanel
          agentId={task().agentIds[0]}
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
                        style={{
                          padding: '2px 8px',
                          background:
                            props.notesTab() === 'notes' ? theme.taskPanelBg : 'transparent',
                          color: props.notesTab() === 'notes' ? theme.fg : theme.fgMuted,
                          border: 'none',
                          'border-bottom':
                            props.notesTab() === 'notes'
                              ? `2px solid ${theme.accent}`
                              : '2px solid transparent',
                          cursor: 'pointer',
                          ...typography.monoMeta,
                        }}
                        onClick={() => props.setNotesTab('notes')}
                      >
                        Notes
                      </button>
                      <button
                        style={{
                          padding: '2px 8px',
                          background:
                            props.notesTab() === 'plan' ? theme.taskPanelBg : 'transparent',
                          color: props.notesTab() === 'plan' ? theme.fg : theme.fgMuted,
                          border: 'none',
                          'border-bottom':
                            props.notesTab() === 'plan'
                              ? `2px solid ${theme.accent}`
                              : '2px solid transparent',
                          cursor: 'pointer',
                          ...typography.monoMeta,
                        }}
                        onClick={() => props.setNotesTab('plan')}
                      >
                        Plan
                      </button>
                    </div>
                  </Show>

                  <Show
                    when={props.notesTab() === 'notes' || !store.showPlans || !task().planContent}
                  >
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
                    </div>
                  </Show>

                  <Show when={isPlanVisible()}>
                    <div
                      style={{
                        position: 'relative',
                        flex: '1',
                        overflow: 'hidden',
                        background: theme.taskPanelBg,
                      }}
                    >
                      <button
                        onClick={() => {
                          void openPlanViewer();
                        }}
                        title="Review Plan"
                        style={{
                          position: 'absolute',
                          top: '10px',
                          right: '10px',
                          'z-index': '1',
                          padding: '4px 10px',
                          background: 'rgba(0, 0, 0, 0.72)',
                          color: theme.fg,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '999px',
                          cursor: 'pointer',
                          'backdrop-filter': 'blur(10px)',
                          ...typography.monoMeta,
                        }}
                      >
                        Review Plan
                      </button>
                      <div
                        ref={(element) => {
                          planContentRef = element;
                          props.setPlanFocusRef(element);
                        }}
                        tabIndex={0}
                        class="plan-markdown"
                        style={{
                          height: '100%',
                          overflow: 'auto',
                          padding: '6px 8px',
                          color: theme.fg,
                          outline: 'none',
                          ...typography.monoUi,
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && event.currentTarget === event.target) {
                            event.preventDefault();
                            void openPlanViewer();
                          }
                        }}
                        // eslint-disable-next-line solid/no-innerhtml -- plan content is rendered through the shared sanitized markdown renderer
                        innerHTML={planHtml()}
                      />
                    </div>
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
                        size="sm"
                        title={reviewOpen() ? 'Show changed files' : 'Open review'}
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
