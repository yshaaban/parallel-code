import { setStore, store } from './core';
import type { SidebarSectionKey } from './types';

export function isSidebarSectionCollapsed(section: SidebarSectionKey): boolean {
  return store.sidebarSectionCollapsed[section];
}

export function setSidebarSectionCollapsed(section: SidebarSectionKey, collapsed: boolean): void {
  setStore('sidebarSectionCollapsed', section, collapsed);
}

export function toggleSidebarSection(section: SidebarSectionKey): void {
  setSidebarSectionCollapsed(section, !store.sidebarSectionCollapsed[section]);
}
