import { batch } from 'solid-js';
import { setStore, store } from './core';
import type { SidebarSectionKey } from './types';

export function isSidebarSectionCollapsed(section: SidebarSectionKey): boolean {
  return store.sidebarSectionCollapsed[section];
}

export function clearSidebarFocusedProjectIfHidden(): void {
  if (store.sidebarSectionCollapsed.projects && store.sidebarFocusedProjectId !== null) {
    setStore('sidebarFocusedProjectId', null);
  }
}

export function setSidebarSectionCollapsed(section: SidebarSectionKey, collapsed: boolean): void {
  batch(() => {
    setStore('sidebarSectionCollapsed', section, collapsed);
    if (section === 'projects' && collapsed) {
      clearSidebarFocusedProjectIfHidden();
    }
  });
}

export function toggleSidebarSection(section: SidebarSectionKey): void {
  setSidebarSectionCollapsed(section, !store.sidebarSectionCollapsed[section]);
}
