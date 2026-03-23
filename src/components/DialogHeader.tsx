import { Show, type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

type DialogHeaderAlign = 'center' | 'start';
type DialogHeaderDescriptionTone = 'muted' | 'subtle';
type DialogHeaderTitleSize = 'lg' | 'md';

const DIALOG_HEADER_DESCRIPTION_COLOR: Record<DialogHeaderDescriptionTone, string> = {
  muted: theme.fgMuted,
  subtle: theme.fgSubtle,
};

const DIALOG_HEADER_TITLE_STYLES: Record<DialogHeaderTitleSize, JSX.CSSProperties> = {
  lg: typography.display,
  md: typography.title,
};

interface DialogHeaderProps {
  align?: DialogHeaderAlign;
  description?: JSX.Element;
  descriptionTone?: DialogHeaderDescriptionTone;
  onClose?: () => void;
  title: JSX.Element;
  titleSize?: DialogHeaderTitleSize;
}

export function DialogHeader(props: DialogHeaderProps): JSX.Element {
  const align = () => props.align ?? 'start';
  const descriptionTone = () => props.descriptionTone ?? 'subtle';
  const titleSize = () => props.titleSize ?? 'md';

  return (
    <div
      style={{
        display: 'flex',
        'align-items': props.onClose ? 'center' : 'stretch',
        'justify-content': props.onClose ? 'space-between' : 'flex-start',
        gap: '12px',
      }}
    >
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: props.description ? '4px' : '0',
          flex: '1',
          'min-width': '0',
          'text-align': align() === 'center' ? 'center' : 'left',
          'align-items': align() === 'center' ? 'center' : 'flex-start',
        }}
      >
        <h2
          style={{
            margin: '0',
            ...DIALOG_HEADER_TITLE_STYLES[titleSize()],
            color: theme.fg,
          }}
        >
          {props.title}
        </h2>
        <Show when={props.description}>
          <div
            style={{
              ...typography.ui,
              color: DIALOG_HEADER_DESCRIPTION_COLOR[descriptionTone()],
            }}
          >
            {props.description}
          </div>
        </Show>
      </div>
      <Show when={props.onClose}>
        <button
          type="button"
          aria-label="Close dialog"
          onClick={() => props.onClose?.()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '18px',
            padding: '0 4px',
            'line-height': '1',
            'flex-shrink': '0',
          }}
        >
          &times;
        </button>
      </Show>
    </div>
  );
}
