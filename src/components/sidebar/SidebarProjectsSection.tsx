import { For, Show, createMemo, type JSX } from 'solid-js';
import { IconButton } from '../IconButton';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';
import { isSidebarSectionCollapsed, toggleSidebarSection } from '../../store/sidebar-sections';
import { isProjectMissing, store } from '../../store/store';
import type { Project } from '../../store/types';
import { SidebarSectionHeader } from './SidebarSectionHeader';

function abbreviatePath(path: string): string {
  for (const prefix of ['/home/', '/Users/']) {
    if (!path.startsWith(prefix)) {
      continue;
    }

    const rest = path.slice(prefix.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex !== -1) {
      return `~${rest.slice(slashIndex)}`;
    }

    return '~';
  }

  return path;
}

interface SidebarProjectsSectionProps {
  onAddProject: () => void | Promise<void>;
  onEditProject: (project: Project) => void;
  onRemoveProject: (projectId: string) => void;
}

export function SidebarProjectsSection(props: SidebarProjectsSectionProps): JSX.Element {
  const collapsed = createMemo(() => isSidebarSectionCollapsed('projects'));

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--space-3xs)' }}>
      <SidebarSectionHeader
        actions={
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
              </svg>
            }
            onClick={() => void props.onAddProject()}
            title="Add project"
            size="sm"
          />
        }
        collapsed={collapsed()}
        count={store.projects.length > 0 ? store.projects.length : undefined}
        label="Projects"
        onToggle={() => toggleSidebarSection('projects')}
      />

      <Show when={!collapsed()}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--space-3xs)' }}>
          <For each={store.projects}>
            {(project) => {
              const missing = isProjectMissing(project.id);
              const pathLabel = missing ? 'Folder not found' : abbreviatePath(project.path);

              return (
                <div
                  role="button"
                  tabIndex={0}
                  data-project-id={project.id}
                  onClick={() => props.onEditProject(project)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      props.onEditProject(project);
                    }
                  }}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: 'var(--space-2xs)',
                    padding: '4px var(--space-xs)',
                    'border-radius': '8px',
                    background: missing
                      ? `color-mix(in srgb, ${theme.warning} 8%, ${theme.bgInput})`
                      : theme.bgInput,
                    cursor: 'pointer',
                    border:
                      store.sidebarFocused && store.sidebarFocusedProjectId === project.id
                        ? `1.5px solid var(--border-focus)`
                        : '1.5px solid transparent',
                  }}
                >
                  <div
                    style={{
                      width: '8px',
                      height: '8px',
                      'border-radius': '50%',
                      background: project.color,
                      'flex-shrink': '0',
                    }}
                  />
                  <div style={{ flex: '1', 'min-width': '0', overflow: 'hidden' }}>
                    <div
                      style={{
                        color: theme.fg,
                        ...typography.metaStrong,
                        'white-space': 'nowrap',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                      }}
                    >
                      {project.name}
                    </div>
                    <div
                      style={{
                        color: missing ? theme.warning : theme.fgSubtle,
                        ...typography.meta,
                        'white-space': 'nowrap',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                      }}
                    >
                      {pathLabel}
                    </div>
                  </div>
                  <button
                    class="icon-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onRemoveProject(project.id);
                    }}
                    title="Remove project"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: theme.fgSubtle,
                      cursor: 'pointer',
                      padding: '0 var(--space-3xs)',
                      ...typography.ui,
                      'flex-shrink': '0',
                    }}
                  >
                    &times;
                  </button>
                </div>
              );
            }}
          </For>

          <Show when={store.projects.length === 0}>
            <span
              style={{
                color: theme.fgSubtle,
                padding: '0',
                ...typography.meta,
              }}
            >
              No projects linked yet.
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
