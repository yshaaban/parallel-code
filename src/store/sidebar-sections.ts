import { setStore, store } from './core';
import type { SidebarSectionCollapsedState, SidebarSectionKey } from './types';

export const SIDEBAR_SECTION_KEYS = ['projects', 'progress', 'sessions', 'tips'] as const;

const DEFAULT_SIDEBAR_SECTION_COLLAPSED: SidebarSectionCollapsedState = {
  projects: false,
  progress: true,
  sessions: true,
  tips: true,
};

export function createDefaultSidebarSectionCollapsedState(): SidebarSectionCollapsedState {
  return { ...DEFAULT_SIDEBAR_SECTION_COLLAPSED };
}

export function normalizeSidebarSectionCollapsedState(
  value: unknown,
): SidebarSectionCollapsedState {
  const nextState = createDefaultSidebarSectionCollapsedState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return nextState;
  }

  const raw = value as Partial<Record<SidebarSectionKey, unknown>>;
  for (const key of SIDEBAR_SECTION_KEYS) {
    if (typeof raw[key] === 'boolean') {
      nextState[key] = raw[key];
    }
  }

  return nextState;
}

export function isSidebarSectionCollapsed(section: SidebarSectionKey): boolean {
  return store.sidebarSectionCollapsed[section];
}

export function setSidebarSectionCollapsed(section: SidebarSectionKey, collapsed: boolean): void {
  setStore('sidebarSectionCollapsed', section, collapsed);
}

export function toggleSidebarSection(section: SidebarSectionKey): void {
  setSidebarSectionCollapsed(section, !store.sidebarSectionCollapsed[section]);
}
