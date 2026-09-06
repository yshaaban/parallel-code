import { onMount, onCleanup } from 'solid-js';
import { openNewTaskDialog } from '../app/new-task-dialog-workflows';
import { createTerminal } from '../store/store';
import { registerFocusFn, unregisterFocusFn } from '../store/focus';
import { theme } from '../lib/theme';
import { mod } from '../lib/platform';

export function NewTaskPlaceholder() {
  let addTaskRef: HTMLDivElement | undefined;
  let addTerminalRef: HTMLDivElement | undefined;

  onMount(() => {
    registerFocusFn('placeholder:add-task', () => addTaskRef?.focus());
    registerFocusFn('placeholder:add-terminal', () => addTerminalRef?.focus());
    onCleanup(() => {
      unregisterFocusFn('placeholder:add-task');
      unregisterFocusFn('placeholder:add-terminal');
    });
  });

  return (
    <div
      style={{
        width: '48px',
        'min-width': '48px',
        height: 'calc(100% - 12px)',
        display: 'flex',
        'flex-direction': 'column',
        gap: '4px',
        margin: '6px 3px',
        'flex-shrink': '0',
      }}
    >
      {/* Add task button — fills remaining space */}
      <div
        ref={addTaskRef}
        class="new-task-placeholder"
        role="button"
        tabIndex={0}
        aria-label="New task"
        onClick={() => openNewTaskDialog()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openNewTaskDialog();
          }
        }}
        style={{
          flex: '1',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          cursor: 'pointer',
          'border-radius': '12px',
          border: `2px dashed ${theme.border}`,
          color: theme.fgSubtle,
          'font-size': '20px',
          'user-select': 'none',
        }}
        title={`New task (${mod}+N)`}
      >
        +
      </div>

      {/* Terminal button — same width, fixed height */}
      <div
        ref={addTerminalRef}
        class="new-task-placeholder"
        role="button"
        tabIndex={0}
        aria-label="New terminal"
        onClick={() => createTerminal()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            createTerminal();
          }
        }}
        style={{
          height: '44px',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          cursor: 'pointer',
          'border-radius': '10px',
          border: `2px dashed ${theme.border}`,
          color: theme.fgSubtle,
          'font-size': '13px',
          'font-family': 'monospace',
          'user-select': 'none',
          'flex-shrink': '0',
        }}
        title={`New terminal (${mod}+Shift+D)`}
      >
        &gt;_
      </div>
    </div>
  );
}
