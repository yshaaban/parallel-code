import type { JSX } from 'solid-js';

import type { ReviewAnnotation } from '../app/review-session';
import { sf } from '../lib/fontScale';
import { theme } from '../lib/theme';

interface ReviewCommentCardProps {
  annotation: ReviewAnnotation;
  onDismiss: () => void;
  overlay?: boolean;
}

function getLocationLabel(annotation: ReviewAnnotation): string {
  const sectionIndex = annotation.source.indexOf('\u00A7');
  if (sectionIndex !== -1) {
    return annotation.source.slice(sectionIndex + 1).trim();
  }

  if (annotation.startLine === annotation.endLine) {
    return `line ${annotation.startLine}`;
  }

  return `lines ${annotation.startLine}-${annotation.endLine}`;
}

export function ReviewCommentCard(props: ReviewCommentCardProps): JSX.Element {
  return (
    <div
      style={{
        margin: '4px 40px 4px 80px',
        'max-width': '560px',
        'border-left': `3px solid ${theme.warning}`,
        'border-radius': '0 4px 4px 0',
        background: props.overlay
          ? `color-mix(in srgb, ${theme.bgElevated} 88%, ${theme.warning} 12%)`
          : theme.bgElevated,
        'backdrop-filter': props.overlay ? 'blur(8px)' : undefined,
        padding: '8px 12px',
        'font-family': "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
        }}
      >
        <span
          style={{
            'font-size': sf(11),
            color: props.overlay ? theme.fg : theme.warning,
          }}
        >
          Review · {getLocationLabel(props.annotation)}
        </span>
        <button
          onClick={() => props.onDismiss()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '2px 4px',
            'border-radius': '3px',
            'font-size': sf(14),
            'line-height': '1',
          }}
          title="Dismiss"
        >
          &times;
        </button>
      </div>

      <div
        style={{
          color: theme.fg,
          'white-space': 'pre-wrap',
          'font-size': sf(12),
          'margin-top': '4px',
        }}
      >
        {props.annotation.comment}
      </div>
    </div>
  );
}
