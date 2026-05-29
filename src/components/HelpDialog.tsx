import { For, Show, createUniqueId, type JSX } from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { SectionLabel } from './SectionLabel';
import { formatKeyChord } from '../domain/keybindings';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import { getResolvedKeybindingDefinitions } from '../store/keybindings';

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

function getHelpSections(): Array<{
  shortcuts: Array<{ description: string; key: string }>;
  title: string;
}> {
  const sections = new Map<string, Array<{ description: string; key: string }>>();
  for (const definition of getResolvedKeybindingDefinitions()) {
    const shortcuts = sections.get(definition.category) ?? [];
    shortcuts.push({
      description: definition.description,
      key:
        definition.chords.length > 0
          ? definition.chords.map((chord) => formatKeyChord(chord)).join(' or ')
          : 'Disabled',
    });
    sections.set(definition.category, shortcuts);
  }

  return Array.from(sections.entries()).map(([title, shortcuts]) => ({
    title,
    shortcuts,
  }));
}

export function HelpDialog(props: HelpDialogProps): JSX.Element {
  const titleId = createUniqueId();

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="520px"
      labelledBy={titleId}
      panelStyle={{ gap: '20px', padding: '20px' }}
    >
      <DialogHeader onClose={props.onClose} title="Help & Shortcuts" titleId={titleId} />

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

      <For each={getHelpSections()}>
        {(section) => (
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <SectionLabel>{section.title}</SectionLabel>
            <For each={section.shortcuts}>
              {(shortcut) => (
                <div
                  style={{
                    display: 'flex',
                    'justify-content': 'space-between',
                    'align-items': 'center',
                    padding: '4px 0',
                    gap: '16px',
                  }}
                >
                  <span style={{ color: theme.fgMuted, ...typography.meta }}>
                    {shortcut.description}
                  </span>
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
                    {shortcut.key}
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
