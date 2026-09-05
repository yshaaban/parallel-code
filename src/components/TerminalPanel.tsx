import { createEffect, onCleanup, onMount, untrack, type JSX } from 'solid-js';
import {
  store,
  closeTerminal,
  getTaskFocusedPanel,
  updateTerminalName,
  isTaskPanelFocused,
  setActiveTask,
  reorderTask,
  getFontScale,
  registerFocusFn,
  unregisterFocusFn,
  triggerFocus,
  setTaskFocusedPanel,
} from '../store/store';
import { EditableText, type EditableTextHandle } from './EditableText';
import { IconButton } from './IconButton';
import { ScalablePanel } from './ScalablePanel';
import { TerminalView } from './TerminalView';
import { theme } from '../lib/theme';
import { handleDragReorder, type DragSessionCleanup } from '../lib/drag-reorder';
import type { Terminal } from '../store/types';

interface TerminalPanelProps {
  terminal: Terminal;
  isActive: boolean;
}

export function TerminalPanel(props: TerminalPanelProps): JSX.Element {
  const terminalId = untrack(() => props.terminal.id);
  const agentId = untrack(() => props.terminal.agentId);
  let panelRef!: HTMLDivElement;
  let titleEditHandle: EditableTextHandle | undefined;
  let cleanupTitleDrag: DragSessionCleanup | undefined;

  function clearTitleDrag(): void {
    const cleanup = cleanupTitleDrag;
    cleanupTitleDrag = undefined;
    cleanup?.();
  }

  // Focus registration
  onMount(() => {
    registerFocusFn(`${terminalId}:title`, () => titleEditHandle?.startEdit());

    onCleanup(() => {
      unregisterFocusFn(`${terminalId}:title`);
      unregisterFocusFn(`${terminalId}:terminal`);
    });
  });

  onCleanup(clearTitleDrag);

  // Respond to focus panel changes
  createEffect(() => {
    if (!props.isActive) return;
    const panel = getTaskFocusedPanel(terminalId);
    triggerFocus(`${terminalId}:${panel}`);
  });

  function handleTitleMouseDown(event: MouseEvent): void {
    clearTitleDrag();
    cleanupTitleDrag = handleDragReorder(event, {
      itemId: terminalId,
      getTaskOrder: () => store.taskOrder,
      onSessionEnd: () => {
        cleanupTitleDrag = undefined;
      },
      onReorder: reorderTask,
      onTap: () => setActiveTask(terminalId),
    });
  }

  return (
    <div
      ref={panelRef}
      class={`task-column ${props.isActive ? 'active' : ''}`}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: theme.taskContainerBg,
        'border-radius': '0',
        border: `1px solid ${theme.border}`,
        overflow: 'clip',
        position: 'relative',
      }}
      onClick={() => setActiveTask(terminalId)}
    >
      {/* Title bar */}
      <div
        class={props.isActive ? 'island-header-active' : ''}
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '0 10px',
          height: '36px',
          'min-height': '36px',
          background: 'transparent',
          'border-bottom': `1px solid ${theme.border}`,
          'user-select': 'none',
          cursor: 'grab',
          'flex-shrink': '0',
        }}
        onMouseDown={handleTitleMouseDown}
      >
        <div
          style={{
            overflow: 'hidden',
            flex: '1',
            'min-width': '0',
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <span
            style={{
              'font-family': 'monospace',
              'font-size': '13px',
              color: theme.fgMuted,
              'flex-shrink': '0',
            }}
          >
            &gt;_
          </span>
          <EditableText
            value={props.terminal.name}
            onCommit={(v) => updateTerminalName(terminalId, v)}
            class="editable-text"
            onHandle={(h) => (titleEditHandle = h)}
          />
        </div>
        <div style={{ display: 'flex', gap: '4px', 'margin-left': '8px', 'flex-shrink': '0' }}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            }
            onClick={() => closeTerminal(terminalId)}
            title="Close terminal"
          />
        </div>
      </div>

      {/* Terminal */}
      <ScalablePanel panelId={`${terminalId}:terminal`}>
        <div
          class="focusable-panel"
          style={{
            height: '100%',
            position: 'relative',
          }}
          onClick={() => setTaskFocusedPanel(terminalId, 'terminal')}
        >
          <TerminalView
            taskId={terminalId}
            agentId={agentId}
            isShell
            isFocused={props.isActive && isTaskPanelFocused(terminalId, 'terminal')}
            command=""
            args={['-l']}
            cwd=""
            focusPanelId="terminal"
            sessionOwner="compatibility-shell"
            onReady={(focusFn) => registerFocusFn(`${terminalId}:terminal`, focusFn)}
            fontSize={Math.round(store.terminalFontSize * getFontScale(`${terminalId}:terminal`))}
          />
        </div>
      </ScalablePanel>
    </div>
  );
}
