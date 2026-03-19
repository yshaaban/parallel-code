import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebarTaskRowSource = readFileSync(
  path.resolve(process.cwd(), 'src/components/SidebarTaskRow.tsx'),
  'utf8',
);

describe('sidebar task row architecture guardrails', () => {
  it('derives row status from canonical task presentation state', () => {
    expect(sidebarTaskRowSource).toContain('getTaskAttentionEntry');
    expect(sidebarTaskRowSource).toContain('getTaskDotStatus');
    expect(sidebarTaskRowSource).toContain('getTaskTerminalStartupSummary');
    expect(sidebarTaskRowSource).not.toContain('store.agentSupervision');
    expect(sidebarTaskRowSource).not.toContain('store.taskGitStatus');
    expect(sidebarTaskRowSource).not.toContain('store.taskReview');
  });
});
