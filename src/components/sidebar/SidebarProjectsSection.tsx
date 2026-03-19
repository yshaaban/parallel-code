import { For, Show, createMemo, type JSX } from 'solid-js';
import { IconButton } from '../IconButton';
import { sf } from '../../lib/fontScale';
import { theme } from '../../lib/theme';
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
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
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
        <>
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
                    gap: '6px',
                    padding: '4px 6px',
                    'border-radius': '6px',
                    background: missing
                      ? `color-mix(in srgb, ${theme.warning} 8%, ${theme.bgInput})`
                      : theme.bgInput,
                    'font-size': sf(11),
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
                        'font-weight': '500',
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
                        'font-size': sf(10),
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
                      'font-size': sf(12),
                      'line-height': '1',
                      padding: '0 2px',
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
            <span style={{ 'font-size': sf(10), color: theme.fgSubtle, padding: '0 2px' }}>
              No projects linked yet.
            </span>
          </Show>
        </>
      </Show>
    </div>
  );
}
