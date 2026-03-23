import { For, Show } from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { SectionLabel } from './SectionLabel';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { alt, mod } from '../lib/platform';

interface HelpDialogProps {
  onClose: () => void;
  open: boolean;
  showIntro?: boolean;
}

const INTRO_ITEMS = [
  'Name each session so peers can see who is active on desktop and mobile.',
  'Ownership follows the person currently typing. Use Take Over when another session controls a terminal or prompt.',
  'Use the mobile remote link to watch agents live, then jump into the terminal when you need control.',
  'Reopen this guide any time from Tips, F1, or Cmd/Ctrl + /.',
] as const;

const SECTIONS = [
  {
    title: 'Navigation',
    shortcuts: [
      [`${alt} + Up/Down`, 'Move between panels or sidebar tasks'],
      [`${alt} + Left/Right`, 'Navigate within row or across tasks'],
      [`${alt} + Left (from first task)`, 'Focus sidebar'],
      [`${alt} + Right (from sidebar)`, 'Focus active task'],
      ['Enter (in sidebar)', 'Jump to active task panel'],
    ],
  },
  {
    title: 'Task Actions',
    shortcuts: [
      [`${mod} + Enter`, 'Send prompt'],
      [`${mod} + W`, 'Close focused terminal'],
      [`${mod} + Shift + W`, 'Close active task/terminal'],
      [`${mod} + Shift + M`, 'Merge active task'],
      [`${mod} + Shift + P`, 'Push to remote'],
      [`${mod} + Shift + T`, 'New task shell terminal'],
      [`${mod} + Shift + Left/Right`, 'Reorder active task'],
    ],
  },
  {
    title: 'App',
    shortcuts: [
      [`${mod} + N`, 'New task'],
      [`${mod} + Shift + D`, 'New standalone terminal'],
      [`${mod} + Shift + A`, 'New task'],
      [`${mod} + B`, 'Toggle sidebar'],
      [`${mod} + ,`, 'Open settings'],
      [`${mod} + 0`, 'Reset zoom'],
      ['Ctrl + Shift + Scroll', 'Resize all panel widths'],
      [`${mod} + / or F1`, 'Toggle this help'],
      ['Escape', 'Close dialogs'],
    ],
  },
];

export function HelpDialog(props: HelpDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} width="520px" panelStyle={{ gap: '20px' }}>
      <DialogHeader onClose={props.onClose} title="Help & Shortcuts" />

      <Show when={props.showIntro}>
        <div
          style={{
            display: 'grid',
            gap: '10px',
            padding: '14px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '12px',
          }}
        >
          <SectionLabel>Getting Started</SectionLabel>
          <For each={INTRO_ITEMS}>
            {(item) => (
              <div style={{ display: 'flex', gap: '8px', 'align-items': 'flex-start' }}>
                <span style={{ color: theme.accent, ...typography.meta }}>•</span>
                <span style={{ color: theme.fgMuted, ...typography.meta }}>{item}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <For each={SECTIONS}>
        {(section) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <SectionLabel>{section.title}</SectionLabel>
            <For each={section.shortcuts}>
              {([key, desc]) => (
                <div
                  style={{
                    display: 'flex',
                    'justify-content': 'space-between',
                    'align-items': 'center',
                    padding: '4px 0',
                    gap: '16px',
                  }}
                >
                  <span style={{ color: theme.fgMuted, ...typography.meta }}>{desc}</span>
                  <kbd
                    style={{
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '4px',
                      padding: '2px 8px',
                      color: theme.fg,
                      'white-space': 'nowrap',
                      ...typography.monoMeta,
                    }}
                  >
                    {key}
                  </kbd>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </Dialog>
  );
}
