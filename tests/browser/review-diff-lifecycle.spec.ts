import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { IPC } from '../../electron/ipc/channels.js';
import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

interface BrowserLabIpcServer {
  authToken: string;
  baseUrl: string;
}

function git(repoDir: string, ...args: string[]): void {
  try {
    execFileSync('git', args, {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error && 'stderr' in error
        ? String((error as { stderr?: Buffer | string }).stderr ?? '')
        : '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr.trim()}` : ''}`);
  }
}

function readGit(repoDir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
  });
}

function commitRepoFiles(repoDir: string, message: string, ...paths: string[]): void {
  git(repoDir, 'add', ...paths);
  git(repoDir, 'commit', '-m', message);
}

function writeRepoFile(repoDir: string, relativePath: string, content: string | Buffer): void {
  const filePath = path.join(repoDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function deleteRepoFile(repoDir: string, relativePath: string): void {
  rmSync(path.join(repoDir, relativePath), { force: true });
}

async function invokeBrowserLabIpc<TResult>(
  server: BrowserLabIpcServer,
  channel: IPC,
  body?: unknown,
): Promise<TResult> {
  const response = await fetch(`${server.baseUrl}/api/ipc/${channel}`, {
    body: JSON.stringify(body ?? {}),
    headers: {
      Authorization: `Bearer ${server.authToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  expect(response.ok, `IPC ${channel} should return 2xx`).toBe(true);
  const payload = (await response.json()) as { result: TResult };
  return payload.result;
}

async function openReviewPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTitle('Open review').click();
  await expect(page.getByRole('combobox').last()).toHaveValue('all');
}

async function openReviewFullscreen(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTitle('Open review fullscreen').click();
  await expect(page.locator('.dialog-panel').last()).toBeVisible();
}

function getFullscreenReviewSurface(page: import('@playwright/test').Page) {
  return page.locator('.dialog-panel').last();
}

async function selectReviewMode(
  reviewSurface: ReturnType<typeof getFullscreenReviewSurface>,
  mode: 'branch' | 'unstaged',
): Promise<void> {
  await reviewSurface.getByRole('combobox').selectOption(mode);
  await expect(reviewSurface.getByRole('combobox')).toHaveValue(mode);
}

async function clickReviewFile(
  reviewSurface: ReturnType<typeof getFullscreenReviewSurface>,
  filePath: string,
): Promise<void> {
  const fileRow = reviewSurface.locator(`[title="${filePath}"]`).first();
  await expect(fileRow).toBeVisible();
  await fileRow.click();
}

async function listReviewFiles(
  reviewSurface: ReturnType<typeof getFullscreenReviewSurface>,
): Promise<string[]> {
  return reviewSurface
    .locator('[title]')
    .evaluateAll((elements) =>
      [
        ...new Set(
          elements
            .map((element) => element.getAttribute('title'))
            .filter(
              (value): value is string =>
                typeof value === 'string' &&
                value.length > 0 &&
                value.includes('/') &&
                !value.startsWith('/'),
            ),
        ),
      ].sort(),
    );
}

async function expectReviewDiffText(
  reviewSurface: ReturnType<typeof getFullscreenReviewSurface>,
  text: string,
): Promise<void> {
  await expect(reviewSurface.getByText(text).first()).toBeVisible();
}

async function expectBinaryReviewFallback(
  reviewSurface: ReturnType<typeof getFullscreenReviewSurface>,
): Promise<void> {
  await expect(reviewSurface.getByText('Binary file - cannot display diff')).toBeVisible();
}

const reviewDiffLifecycleScenario = {
  ...createInteractiveNodeScenario(),
  name: 'review-diff-lifecycle',
  async seedRepo(repoDir: string): Promise<void> {
    writeRepoFile(repoDir, 'src/flip.ts', 'export const version = "main";\n');
    writeRepoFile(repoDir, 'src/deleted.ts', 'export const deleted = true;\n');
    writeRepoFile(repoDir, 'assets/blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
    commitRepoFiles(
      repoDir,
      'seed review diff lifecycle files',
      'src/flip.ts',
      'src/deleted.ts',
      'assets/blob.bin',
    );
    git(repoDir, 'checkout', '-B', 'browser-lab/e2e');
  },
};

test.describe('browser-lab review diff lifecycle', () => {
  test.use({
    scenario: reviewDiffLifecycleScenario,
  });

  test('tracks worktree and branch review diffs through the standalone browser server', async ({
    browser,
    browserLab,
  }) => {
    const repoDir = browserLab.server.repoDir;

    const session = await browserLab.openSession(browser, {
      displayName: 'Review Diff Lifecycle',
    });
    const { context, page } = session;

    try {
      await browserLab.waitForTerminalReady(page);
      await page.getByTitle('Open review').waitFor({ state: 'visible' });
      await openReviewPanel(page);
      await openReviewFullscreen(page);
      const reviewSurface = getFullscreenReviewSurface(page);

      writeRepoFile(repoDir, 'src/flip.ts', 'export const version = "worktree";\n');
      writeRepoFile(repoDir, 'src/added.ts', 'export const added = true;\n');
      deleteRepoFile(repoDir, 'src/deleted.ts');
      writeRepoFile(repoDir, 'assets/blob.bin', Buffer.from([0x10, 0x11, 0x12, 0xff, 0x20]));

      await selectReviewMode(reviewSurface, 'unstaged');
      await expect
        .poll(() => listReviewFiles(reviewSurface), { timeout: 15_000 })
        .toEqual(['assets/blob.bin', 'src/added.ts', 'src/deleted.ts', 'src/flip.ts']);
      await clickReviewFile(reviewSurface, 'src/flip.ts');
      await expectReviewDiffText(reviewSurface, 'export const version = "worktree";');
      await clickReviewFile(reviewSurface, 'src/added.ts');
      await expectReviewDiffText(reviewSurface, 'export const added = true;');
      await clickReviewFile(reviewSurface, 'src/deleted.ts');
      await expectReviewDiffText(reviewSurface, 'export const deleted = true;');
      await clickReviewFile(reviewSurface, 'assets/blob.bin');
      await expectBinaryReviewFallback(reviewSurface);

      await invokeBrowserLabIpc(browserLab.server, IPC.CommitAll, {
        message: 'browser lab review diff refresh',
        worktreePath: repoDir,
      });

      await expect
        .poll(
          () => readGit(repoDir, 'diff', '--name-status', 'main..HEAD').trim().split('\n').sort(),
          {
            timeout: 15_000,
          },
        )
        .toEqual(['A\tsrc/added.ts', 'D\tsrc/deleted.ts', 'M\tassets/blob.bin', 'M\tsrc/flip.ts']);

      await selectReviewMode(reviewSurface, 'branch');
      await expect
        .poll(() => listReviewFiles(reviewSurface), { timeout: 15_000 })
        .toEqual(['assets/blob.bin', 'src/added.ts', 'src/deleted.ts', 'src/flip.ts']);
      await clickReviewFile(reviewSurface, 'src/flip.ts');
      await expectReviewDiffText(reviewSurface, 'export const version = "worktree";');
      await clickReviewFile(reviewSurface, 'src/added.ts');
      await expectReviewDiffText(reviewSurface, 'export const added = true;');
      await clickReviewFile(reviewSurface, 'src/deleted.ts');
      await expectReviewDiffText(reviewSurface, 'export const deleted = true;');
      await clickReviewFile(reviewSurface, 'assets/blob.bin');
      await expectBinaryReviewFallback(reviewSurface);
    } finally {
      await context.close();
    }
  });
});
