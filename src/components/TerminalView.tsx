import { createEffect, onCleanup, onMount, type JSX } from 'solid-js';

import { getTerminalFontFamily } from '../lib/fonts';
import { getTerminalTheme } from '../lib/theme';
import { markDirty } from '../lib/terminalFitManager';
import { touchWebglAddon } from '../lib/webglPool';
import { store } from '../store/store';
import { startTerminalSession } from './terminal-view/terminal-session';
import type { TerminalViewProps } from './terminal-view/types';

export function TerminalView(props: TerminalViewProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let session: ReturnType<typeof startTerminalSession> | undefined;

  onMount(() => {
    session = startTerminalSession({ containerRef, props });

    onCleanup(() => {
      session?.cleanup();
      session = undefined;
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || size === null || !session) return;
    session.term.options.fontSize = size;
    markDirty(props.agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!session) return;
    session.term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(props.agentId);
  });

  createEffect(() => {
    const preset = store.themePreset;
    if (!session) return;
    session.term.options.theme = getTerminalTheme(preset);
    markDirty(props.agentId);
  });

  createEffect(() => {
    if (!session) return;
    session.term.options.cursorBlink = props.isFocused === true;
    if (props.isFocused === true) {
      touchWebglAddon(props.agentId);
    }
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        padding: '4px 0 0 4px',
        contain: 'strict',
      }}
    />
  );
}

export type { TerminalViewProps } from './terminal-view/types';
