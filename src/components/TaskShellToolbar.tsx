import { For, type JSX } from 'solid-js';
import type { TerminalBookmark } from '../store/types';
import { extractLabel } from '../lib/bookmarks';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

interface TaskShellToolbarProps {
  bookmarks: TerminalBookmark[];
  focused: boolean;
  selectedIndex: number;
  openTerminalTitle: string;
  onToolbarClick: () => void;
  onToolbarFocus: () => void;
  onToolbarBlur: () => void;
  onToolbarKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent>;
  onOpenTerminal: (event: MouseEvent) => void;
  onRunBookmark: (command: string, event: MouseEvent) => void;
  setToolbarRef: (element: HTMLDivElement) => void;
}

function getToolbarButtonBorder(selected: boolean): string {
  return `1px solid ${selected ? theme.accent : theme.border}`;
}

export function TaskShellToolbar(props: TaskShellToolbarProps): JSX.Element {
  return (
    <div
      ref={props.setToolbarRef}
      class="focusable-panel shell-toolbar-panel"
      tabIndex={0}
      onClick={() => props.onToolbarClick()}
      onFocus={() => props.onToolbarFocus()}
      onBlur={() => props.onToolbarBlur()}
      onKeyDown={(event) => props.onToolbarKeyDown(event)}
      style={{
        height: '28px',
        'min-height': '28px',
        display: 'flex',
        'align-items': 'center',
        padding: '0 8px',
        background: 'transparent',
        gap: '4px',
        outline: 'none',
      }}
    >
      <button
        class="icon-btn"
        onClick={(event) => props.onOpenTerminal(event)}
        tabIndex={-1}
        title={props.openTerminalTitle}
        style={{
          background: theme.taskPanelBg,
          border: getToolbarButtonBorder(props.selectedIndex === 0 && props.focused),
          color: theme.fgMuted,
          cursor: 'pointer',
          'border-radius': '4px',
          padding: '4px 12px',
          'font-size': sf(13),
          'line-height': '1',
          display: 'flex',
          'align-items': 'center',
          gap: '4px',
        }}
      >
        <span style={{ 'font-family': 'monospace', 'font-size': sf(13) }}>&gt;_</span>
        <span>Terminal</span>
      </button>
      <For each={props.bookmarks}>
        {(bookmark, index) => (
          <button
            class="icon-btn"
            onClick={(event) => props.onRunBookmark(bookmark.command, event)}
            tabIndex={-1}
            title={bookmark.command}
            style={{
              background: theme.taskPanelBg,
              border: getToolbarButtonBorder(props.selectedIndex === index() + 1 && props.focused),
              color: theme.fgMuted,
              cursor: 'pointer',
              'border-radius': '4px',
              padding: '4px 12px',
              'font-size': sf(13),
              'line-height': '1',
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
            }}
          >
            <span>{extractLabel(bookmark.command)}</span>
          </button>
        )}
      </For>
    </div>
  );
}
