import { Show, type Accessor, type JSX, type Setter } from 'solid-js';
import { marked } from 'marked';

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
  setNotesTab: Setter<'notes' | 'plan'>;
  setPlanFullscreen: Setter<boolean>;
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

  return (
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
                        background: props.notesTab() === 'plan' ? theme.taskPanelBg : 'transparent',
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
                    <button
                      style={{
                        'margin-left': 'auto',
                        padding: '2px 6px',
                        'font-size': sf(10),
                        background: 'transparent',
                        color: theme.fgMuted,
                        border: 'none',
                        cursor: 'pointer',
                        'font-family': "'JetBrains Mono', monospace",
                      }}
                      title="Open plan fullscreen"
                      onClick={() => props.setPlanFullscreen(true)}
                    >
                      {'⤢'}
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

                <Show when={props.notesTab() === 'plan' && store.showPlans && task().planContent}>
                  <div
                    class="plan-markdown"
                    style={{
                      flex: '1',
                      overflow: 'auto',
                      padding: '6px 8px',
                      background: theme.taskPanelBg,
                      color: theme.fg,
                      'font-size': sf(11),
                      'font-family': "'JetBrains Mono', monospace",
                    }}
                    // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
                    innerHTML={marked.parse(task().planContent ?? '', { async: false }) as string}
                  />
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
                  <span>Changed Files</span>
                  <button
                    style={{
                      background: 'transparent',
                      border: `1px solid ${theme.border}`,
                      color: store.reviewPanelOpen[task().id] ? theme.accent : theme.fgMuted,
                      'font-size': sf(9),
                      'font-family': "'JetBrains Mono', monospace",
                      padding: '1px 6px',
                      'border-radius': '3px',
                      cursor: 'pointer',
                      'text-transform': 'none',
                      'letter-spacing': 'normal',
                      'font-weight': 'normal',
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setReviewPanelOpen(task().id, !store.reviewPanelOpen[task().id]);
                    }}
                  >
                    {store.reviewPanelOpen[task().id] ? '<- Files' : 'Review >'}
                  </button>
                </div>
                <div style={{ flex: '1', overflow: 'hidden' }}>
                  <Show
                    when={store.reviewPanelOpen[task().id]}
                    fallback={
                      <ChangedFilesList
                        worktreePath={task().worktreePath}
                        projectRoot={getProject(task().projectId)?.path}
                        branchName={task().branchName}
                        filterHydraArtifacts={props.isHydraTask()}
                        isActive={props.isActive()}
                        onFileClick={props.onFileClick}
                        ref={props.setChangedFilesRef}
                      />
                    }
                  >
                    <ReviewPanel
                      taskId={task().id}
                      worktreePath={task().worktreePath}
                      projectRoot={getProject(task().projectId)?.path}
                      branchName={task().branchName}
                      isActive={props.isActive()}
                    />
                  </Show>
                </div>
              </div>
            </ScalablePanel>
          ),
        },
      ]}
    />
  );
}
