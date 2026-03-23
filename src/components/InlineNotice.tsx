import type { JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

type InlineNoticeTone = 'error' | 'neutral' | 'success' | 'warning';
type InlineNoticeWeight = 'medium' | 'normal' | 'semibold';

interface InlineNoticeToneStyles {
  background: string;
  border: string;
  color: string;
}

const INLINE_NOTICE_TONE_STYLES: Record<InlineNoticeTone, InlineNoticeToneStyles> = {
  neutral: {
    background: theme.bgInput,
    border: `1px solid ${theme.border}`,
    color: theme.fgMuted,
  },
  warning: {
    background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
    border: `1px solid color-mix(in srgb, ${theme.warning} 20%, transparent)`,
    color: theme.warning,
  },
  error: {
    background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
    border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
    color: theme.error,
  },
  success: {
    background: `color-mix(in srgb, ${theme.success} 8%, transparent)`,
    border: `1px solid color-mix(in srgb, ${theme.success} 20%, transparent)`,
    color: theme.success,
  },
};

const INLINE_NOTICE_WEIGHT_BY_KEY: Record<InlineNoticeWeight, string> = {
  normal: '400',
  medium: '500',
  semibold: '600',
};

interface InlineNoticeProps {
  children: JSX.Element;
  role?: JSX.HTMLAttributes<HTMLDivElement>['role'];
  style?: JSX.CSSProperties;
  tone?: InlineNoticeTone;
  weight?: InlineNoticeWeight;
}

export function InlineNotice(props: InlineNoticeProps): JSX.Element {
  const tone = () => props.tone ?? 'neutral';
  const weight = () => props.weight ?? 'normal';
  const toneStyles = () => INLINE_NOTICE_TONE_STYLES[tone()];

  return (
    <div
      role={props.role}
      style={{
        ...typography.meta,
        color: toneStyles().color,
        background: toneStyles().background,
        padding: '8px 12px',
        'border-radius': '8px',
        border: toneStyles().border,
        'font-weight': INLINE_NOTICE_WEIGHT_BY_KEY[weight()],
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
