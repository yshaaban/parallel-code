import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../../store/core';
import { createTestProject, resetStoreForTest } from '../../test/store-test-helpers';

const { isProjectMissingMock } = vi.hoisted(() => ({
  isProjectMissingMock: vi.fn(() => false),
}));

vi.mock('../../store/store', async () => {
  const core = await vi.importActual<typeof import('../../store/core')>('../../store/core');
  return {
    isProjectMissing: isProjectMissingMock,
    store: core.store,
  };
});

import { SidebarProjectsSection } from './SidebarProjectsSection';

describe('SidebarProjectsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreForTest();
  });

  it('starts expanded and collapses on header click', () => {
    setStore('projects', [createTestProject()]);

    render(() => (
      <SidebarProjectsSection
        onAddProject={() => {}}
        onEditProject={() => {}}
        onRemoveProject={() => {}}
      />
    ));

    expect(screen.getByText('Project')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^Projects\b/ }));

    expect(screen.queryByText('Project')).toBeNull();
  });

  it('keeps the add-project action separate from the collapse toggle', () => {
    const onAddProject = vi.fn();

    render(() => (
      <SidebarProjectsSection
        onAddProject={onAddProject}
        onEditProject={() => {}}
        onRemoveProject={() => {}}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));

    expect(onAddProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No projects linked yet.')).toBeDefined();
  });
});
