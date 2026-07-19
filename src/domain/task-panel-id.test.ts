import { describe, expect, it } from 'vitest';

import { parseIndexedTaskPanelId } from './task-panel-id';

describe('parseIndexedTaskPanelId', () => {
  it.each([
    ['shell:0', 'shell', 0],
    ['shell:02', 'shell', 2],
    ['shell-toolbar:3', 'shell-toolbar', 3],
  ] as const)('parses %s as a %s index', (panelId, kind, expected) => {
    expect(parseIndexedTaskPanelId(panelId, kind)).toBe(expected);
  });

  it.each([
    ['shell:0junk', 'shell'],
    ['shell:0.5', 'shell'],
    ['shell:-1', 'shell'],
    ['shell-toolbar:2junk', 'shell-toolbar'],
    ['shell-toolbar:2.5', 'shell-toolbar'],
    ['shell-toolbar:-1', 'shell-toolbar'],
    ['shell-toolbar:9007199254740992', 'shell-toolbar'],
  ] as const)('rejects malformed %s', (panelId, kind) => {
    expect(parseIndexedTaskPanelId(panelId, kind)).toBeNull();
  });
});
