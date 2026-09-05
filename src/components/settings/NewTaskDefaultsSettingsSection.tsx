import { createUniqueId, type JSX } from 'solid-js';

import type { NewTaskDefaultKey, NewTaskDefaults } from '../../domain/new-task-defaults';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import { SectionLabel } from '../SectionLabel';

interface NewTaskDefaultsSettingsSectionProps {
  defaults: Readonly<NewTaskDefaults>;
  onChange: (key: NewTaskDefaultKey, enabled: boolean) => void;
}

export function NewTaskDefaultsSettingsSection(
  props: NewTaskDefaultsSettingsSectionProps,
): JSX.Element {
  const sectionTitleId = createUniqueId();
  const stepsTitleId = createUniqueId();
  const stepsDescriptionId = createUniqueId();
  const permissionsTitleId = createUniqueId();
  const permissionsDescriptionId = createUniqueId();

  const rowStyle: JSX.CSSProperties = {
    display: 'flex',
    'align-items': 'flex-start',
    gap: '10px',
    cursor: 'pointer',
    padding: '9px 12px',
    'border-radius': '8px',
    background: theme.bgInput,
    border: `1px solid ${theme.border}`,
  };

  return (
    <section
      aria-labelledby={sectionTitleId}
      style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}
    >
      <SectionLabel as="h2" style={{ margin: '0' }}>
        <span id={sectionTitleId}>New task defaults</span>
      </SectionLabel>

      <label style={rowStyle}>
        <input
          aria-describedby={stepsDescriptionId}
          aria-labelledby={stepsTitleId}
          type="checkbox"
          checked={props.defaults.stepsTracking}
          onChange={(event) => props.onChange('stepsTracking', event.currentTarget.checked)}
          style={{ 'accent-color': theme.accent, cursor: 'inherit', 'margin-top': '2px' }}
        />
        <span style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
          <span id={stepsTitleId} style={{ ...typography.ui, color: theme.fg }}>
            Track task steps
          </span>
          <span id={stepsDescriptionId} style={{ ...typography.meta, color: theme.fgSubtle }}>
            Watch <code>.claude/steps.json</code> for every new task unless you turn it off in the
            task dialog.
          </span>
        </span>
      </label>

      <label
        style={{
          ...rowStyle,
          background: `color-mix(in srgb, ${theme.warning} 7%, ${theme.bgInput})`,
          border: `1px solid color-mix(in srgb, ${theme.warning} 28%, ${theme.border})`,
        }}
      >
        <input
          aria-describedby={permissionsDescriptionId}
          aria-labelledby={permissionsTitleId}
          type="checkbox"
          checked={props.defaults.skipPermissions}
          onChange={(event) => props.onChange('skipPermissions', event.currentTarget.checked)}
          style={{ 'accent-color': theme.warning, cursor: 'inherit', 'margin-top': '2px' }}
        />
        <span style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
          <span id={permissionsTitleId} style={{ ...typography.uiStrong, color: theme.warning }}>
            Dangerously skip all confirms
          </span>
          <span id={permissionsDescriptionId} style={{ ...typography.meta, color: theme.fgMuted }}>
            Runs without asking for confirmation. The agent can read, write, delete, and execute
            commands without your approval. Applies only to supported agent tasks.
          </span>
        </span>
      </label>
    </section>
  );
}
