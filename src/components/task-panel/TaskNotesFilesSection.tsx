import { Show, createEffect, createSignal, type Accessor, type JSX, type Setter } from 'solid-js';
import { marked } from 'marked';

import { createDialogScroll } from '../../lib/dialog-scroll';
import { sf } from '../../lib/fontScale';
import { theme } from '../../lib/theme';
import type { ChangedFile } from '../../ipc/types';
import {
  getProject,
  setReviewPanelOpen,
  setTaskFocusedPanel,
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
import { PlanViewerDialog } from '../PlanViewerDialog';

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
  const task = () => props.task();
  const [showFilesFullscreen, setShowFilesFullscreen] = createSignal(false);
  const [showPlanViewer, setShowPlanViewer] = createSignal(false);
  const projectPath = () => getProject(task().projectId)?.path;
  const reviewOpen = () => store.reviewPanelOpen[task().id];
  const filesPanelTitle = () => (reviewOpen() ? 'Review' : 'Changed Files');
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

  function closePlanViewer(): void {
    setShowPlanViewer(false);
  }

  function openPlanViewer(): void {
    setShowPlanViewer(true);
  }

  function toggleReviewPanel(): void {
    setReviewPanelOpen(task().id, !reviewOpen());
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
                          'font-size': sf(10),
                          background:
                            props.notesTab() === 'notes' ? theme.taskPanelBg : 'transparent',
                          color: props.notesTab() === 'notes' ? theme.fg : theme.fgMuted,
                          border: 'none',
                          'border-bottom':
                            props.notesTab() === 'notes'
                              ? `2px solid ${theme.accent}`
                              : '2px solid transparent',
                          cursor: 'pointer',
                          'font-family': "'JetBrains Mono', monospace",
                        }}
                        onClick={() => props.setNotesTab('notes')}
                      >
                        Notes
                      </button>
                      <button
                        style={{
                          padding: '2px 8px',
                          'font-size': sf(10),
                          background:
                            props.notesTab() === 'plan' ? theme.taskPanelBg : 'transparent',
                          color: props.notesTab() === 'plan' ? theme.fg : theme.fgMuted,
                          border: 'none',
                          'border-bottom':
                            props.notesTab() === 'plan'
                              ? `2px solid ${theme.accent}`
                              : '2px solid transparent',
                          cursor: 'pointer',
                          'font-family': "'JetBrains Mono', monospace",
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
                        padding: '6px 8px',
                        color: theme.fg,
                        'font-size': sf(11),
                        'font-family': "'JetBrains Mono', monospace",
                        resize: 'none',
                        outline: 'none',
                      }}
                    />
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
                        onClick={openPlanViewer}
                        title="Review Plan"
                        style={{
                          position: 'absolute',
                          top: '10px',
                          right: '10px',
                          'z-index': '1',
                          padding: '4px 10px',
                          'font-size': sf(10),
                          background: 'rgba(0, 0, 0, 0.72)',
                          color: theme.fg,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '999px',
                          cursor: 'pointer',
                          'font-family': "'JetBrains Mono', monospace",
                          'backdrop-filter': 'blur(10px)',
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
                          'font-size': sf(11),
                          'font-family': "'JetBrains Mono', monospace",
                          outline: 'none',
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && event.currentTarget === event.target) {
                            event.preventDefault();
                            openPlanViewer();
                          }
                        }}
                        // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
                        innerHTML={
                          marked.parse(task().planContent ?? '', { async: false }) as string
                        }
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
                      'font-size': sf(10),
                      'font-weight': '600',
                      color: theme.fgMuted,
                      'text-transform': 'uppercase',
                      'letter-spacing': '0.05em',
                      'border-bottom': `1px solid ${theme.border}`,
                      'flex-shrink': '0',
                      display: 'flex',
                      'align-items': 'center',
                      'justify-content': 'space-between',
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
              style={{
                color: theme.fg,
                'font-size': sf(12),
                'font-weight': '600',
                'font-family': "'JetBrains Mono', monospace",
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
      <PlanViewerDialog
        open={showPlanViewer()}
        onClose={closePlanViewer}
        planContent={task().planContent ?? ''}
        planFileName={task().planFileName}
        taskId={task().id}
        agentId={task().agentIds[0]}
        worktreePath={task().worktreePath}
      />
    </>
  );
}
