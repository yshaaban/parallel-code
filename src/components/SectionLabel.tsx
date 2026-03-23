import type { JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

type SectionLabelTone = 'muted' | 'subtle';

const SECTION_LABEL_COLOR: Record<SectionLabelTone, string> = {
  muted: theme.fgMuted,
  subtle: theme.fgSubtle,
};

interface SectionLabelProps {
  as?: keyof JSX.IntrinsicElements;
  children: JSX.Element;
  style?: JSX.CSSProperties;
  tone?: SectionLabelTone;
}

export function SectionLabel(props: SectionLabelProps): JSX.Element {
  const tone = () => props.tone ?? 'muted';

  return (
    <Dynamic
      component={props.as ?? 'div'}
      style={{
        ...typography.label,
        color: SECTION_LABEL_COLOR[tone()],
        ...props.style,
      }}
    >
      {props.children}
    </Dynamic>
  );
}
