import type { JSX } from 'solid-js';

const monoNumericStyles = {
  'font-family': 'var(--font-mono)',
  'font-variant-numeric': 'tabular-nums',
} as const satisfies JSX.CSSProperties;

export const typography = {
  body: {
    'font-size': 'var(--text-body-size)',
    'line-height': 'var(--text-body-line-height)',
    'font-weight': 'var(--font-weight-regular)',
  },
  display: {
    'font-family': 'var(--font-display)',
    'font-size': 'var(--text-display-size)',
    'line-height': 'var(--text-display-line-height)',
    'font-weight': 'var(--font-weight-bold)',
    'letter-spacing': 'var(--tracking-tight)',
  },
  label: {
    'font-size': 'var(--text-label-size)',
    'line-height': 'var(--text-label-line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-label)',
    'text-transform': 'uppercase',
  },
  meta: {
    'font-size': 'var(--text-meta-size)',
    'line-height': 'var(--text-meta-line-height)',
    'font-weight': 'var(--font-weight-regular)',
  },
  metaStrong: {
    'font-size': 'var(--text-meta-size)',
    'line-height': 'var(--text-meta-line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  monoMeta: {
    ...monoNumericStyles,
    'font-size': 'var(--text-meta-size)',
    'line-height': 'var(--text-meta-line-height)',
    'font-weight': 'var(--font-weight-regular)',
  },
  monoUi: {
    ...monoNumericStyles,
    'font-size': 'var(--text-ui-size)',
    'line-height': 'var(--text-ui-line-height)',
    'font-weight': 'var(--font-weight-regular)',
  },
  title: {
    'font-family': 'var(--font-display)',
    'font-size': 'var(--text-title-size)',
    'line-height': 'var(--text-title-line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-tight)',
  },
  ui: {
    'font-size': 'var(--text-ui-size)',
    'line-height': 'var(--text-ui-line-height)',
    'font-weight': 'var(--font-weight-regular)',
  },
  uiStrong: {
    'font-size': 'var(--text-ui-size)',
    'line-height': 'var(--text-ui-line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
} as const satisfies Record<string, JSX.CSSProperties>;
