import type { JSX } from 'solid-js';
import { createMemo } from 'solid-js';
import { normalizeRemoteAgentGlyphKind, type RemoteAgentGlyphKind } from './agent-presentation';

interface GlyphPalette {
  background: string;
  border: string;
  stroke: string;
  accent: string;
}

interface RemoteAgentGlyphProps {
  agentDefId: string | null;
  agentDefName: string | null;
  class?: string;
  size?: number;
  variant?: 'card' | 'default';
}

function getGlyphPalette(kind: RemoteAgentGlyphKind): GlyphPalette {
  switch (kind) {
    case 'claude':
      return {
        background: 'rgba(244, 163, 106, 0.18)',
        border: 'rgba(244, 163, 106, 0.40)',
        stroke: '#f0b07e',
        accent: '#ffd8bb',
      };
    case 'gemini':
      return {
        background: 'rgba(126, 182, 255, 0.18)',
        border: 'rgba(126, 182, 255, 0.42)',
        stroke: '#8fd0ff',
        accent: '#d7f0ff',
      };
    case 'codex':
      return {
        background: 'rgba(120, 220, 180, 0.18)',
        border: 'rgba(120, 220, 180, 0.40)',
        stroke: '#77e2bf',
        accent: '#d9fff1',
      };
    case 'opencode':
      return {
        background: 'rgba(245, 156, 255, 0.16)',
        border: 'rgba(245, 156, 255, 0.38)',
        stroke: '#f4b1ff',
        accent: '#fff0ff',
      };
    case 'hydra':
      return {
        background: 'rgba(177, 156, 255, 0.18)',
        border: 'rgba(177, 156, 255, 0.40)',
        stroke: '#cabdff',
        accent: '#f2eeff',
      };
    case 'generic':
      return {
        background: 'rgba(103, 129, 151, 0.14)',
        border: 'rgba(103, 129, 151, 0.26)',
        stroke: 'var(--text-muted)',
        accent: 'var(--text-primary)',
      };
  }
}

function getGlyphLabel(agentDefId: string | null, agentDefName: string | null): string {
  if (agentDefName && agentDefName.trim().length > 0) return agentDefName.trim();
  if (agentDefId && agentDefId.trim().length > 0) return agentDefId.trim();
  return 'Agent';
}

function getGlyphAriaLabel(label: string): string {
  if (label.trim().toLowerCase() === 'agent') {
    return label;
  }

  return `${label} agent`;
}

function ClaudeGlyph(props: { palette: GlyphPalette }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"
        fill={props.palette.stroke}
      />
    </svg>
  );
}

function GeminiGlyph(props: { palette: GlyphPalette }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5C7.3 5.2 5.2 7.3 1.5 8 5.2 8.7 7.3 10.8 8 14.5 8.7 10.8 10.8 8.7 14.5 8 10.8 7.3 8.7 5.2 8 1.5Z"
        fill={props.palette.stroke}
      />
      <path
        d="M12.2 2.4C11.9 3.9 11 4.8 9.5 5.1 11 5.4 11.9 6.3 12.2 7.8 12.5 6.3 13.4 5.4 14.9 5.1 13.4 4.8 12.5 3.9 12.2 2.4Z"
        fill={props.palette.accent}
      />
    </svg>
  );
}

function CodexGlyph(props: { palette: GlyphPalette }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934 4.1 4.1 0 0 0-1.778-.614 4.15 4.15 0 0 0-2.118-.086 4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679 4 4 0 0 0-1.14 1.253.99.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"
        fill={props.palette.stroke}
      />
    </svg>
  );
}

function OpenCodeGlyph(props: { palette: GlyphPalette }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.2 5.1 2.9 8l2.3 2.9M10.8 5.1 13.1 8l-2.3 2.9"
        stroke={props.palette.stroke}
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M6.9 11.6 9.9 4.4"
        stroke={props.palette.accent}
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

function HydraGlyph(props: { palette: GlyphPalette }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 13V8.9" stroke={props.palette.accent} stroke-width="1.5" stroke-linecap="round" />
      <path
        d="M8 9.1 5.1 5.3M8 9.1 10.9 5.3"
        stroke={props.palette.stroke}
        stroke-width="1.45"
        stroke-linecap="round"
      />
      <circle cx="8" cy="3.6" r="1.5" fill={props.palette.accent} />
      <circle cx="4.4" cy="5.1" r="1.5" fill={props.palette.stroke} opacity="0.96" />
      <circle cx="11.6" cy="5.1" r="1.5" fill={props.palette.stroke} opacity="0.96" />
    </svg>
  );
}

function GenericGlyph(props: { palette: GlyphPalette }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3.1"
        y="4.5"
        width="9.8"
        height="7"
        rx="1.4"
        stroke={props.palette.stroke}
        stroke-width="1.35"
      />
      <path
        d="m5.1 7 1.5 1.1-1.5 1.1M8.2 9.2h2.6"
        stroke={props.palette.accent}
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function renderGlyph(kind: RemoteAgentGlyphKind, palette: GlyphPalette): JSX.Element {
  switch (kind) {
    case 'claude':
      return <ClaudeGlyph palette={palette} />;
    case 'gemini':
      return <GeminiGlyph palette={palette} />;
    case 'codex':
      return <CodexGlyph palette={palette} />;
    case 'opencode':
      return <OpenCodeGlyph palette={palette} />;
    case 'hydra':
      return <HydraGlyph palette={palette} />;
    case 'generic':
      return <GenericGlyph palette={palette} />;
  }
}

export function RemoteAgentGlyph(props: RemoteAgentGlyphProps): JSX.Element {
  const kind = createMemo(() =>
    normalizeRemoteAgentGlyphKind(props.agentDefId, props.agentDefName),
  );
  const palette = createMemo(() => getGlyphPalette(kind()));
  const label = createMemo(() => getGlyphLabel(props.agentDefId, props.agentDefName));
  const variant = () => props.variant ?? 'default';
  const size = () => props.size ?? 22;
  const borderRadius = () => (variant() === 'card' ? `${Math.round(size() * 0.28)}px` : '5px');
  const border = () =>
    variant() === 'card' ? `1px solid ${palette().border}` : `1px solid ${palette().border}`;
  const background = () =>
    variant() === 'card'
      ? `linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent), ${palette().background}`
      : palette().background;
  const boxShadow = () => (variant() === 'card' ? `0 0 0 1px ${palette().border} inset` : 'none');
  const padding = () =>
    variant() === 'card' ? `${Math.max(4, Math.round(size() * 0.16))}px` : '3px';

  return (
    <span
      role="img"
      aria-label={getGlyphAriaLabel(label())}
      title={label()}
      class={props.class}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        'flex-shrink': '0',
        'border-radius': borderRadius(),
        background: background(),
        border: border(),
        'box-shadow': boxShadow(),
        'box-sizing': 'border-box',
        padding: padding(),
      }}
    >
      {renderGlyph(kind(), palette())}
    </span>
  );
}
