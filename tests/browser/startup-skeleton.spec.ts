import type { Page } from '@playwright/test';

import { expect, test, waitForAppShellVisible } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

interface StartupSkeletonCapture {
  placeholderSeenBeforeLiveReady: boolean;
  sawForbiddenCopy: string[];
  sawSkeleton: boolean;
  sawZeroColumnFrameAfterSkeleton: boolean;
  skeletonColumnCounts: number[];
}

declare global {
  interface Window {
    __STARTUP_SKELETON_CAPTURE__?: StartupSkeletonCapture;
  }
}

const FORBIDDEN_FIRST_RUN_COPY = ['No tasks yet', 'Link your first project'];

async function readStartupSkeletonCapture(page: Page): Promise<StartupSkeletonCapture> {
  const capture = await page.evaluate(() => window.__STARTUP_SKELETON_CAPTURE__ ?? null);
  expect(capture).not.toBeNull();
  return capture as StartupSkeletonCapture;
}

test.describe('startup skeleton', () => {
  test.use({
    scenario: {
      ...createInteractiveNodeScenario(),
      additionalTaskNames: ['Second Interactive Fixture'],
    },
  });

  test('a returning user never sees first-run onboarding during a cold reload', async ({
    browser,
    browserLab,
  }) => {
    const { page } = await browserLab.openSession(browser, {
      displayName: 'Startup Skeleton Tester',
      prepareContext: async (context) => {
        await context.addInitScript((forbiddenCopy: string[]) => {
          const capture: StartupSkeletonCapture = {
            placeholderSeenBeforeLiveReady: false,
            sawForbiddenCopy: [],
            sawSkeleton: false,
            sawZeroColumnFrameAfterSkeleton: false,
            skeletonColumnCounts: [],
          };
          window.__STARTUP_SKELETON_CAPTURE__ = capture;

          function sample(): void {
            const body = document.body;
            if (!body) {
              return;
            }

            const text = body.textContent ?? '';
            for (const copy of forbiddenCopy) {
              if (text.includes(copy) && !capture.sawForbiddenCopy.includes(copy)) {
                capture.sawForbiddenCopy.push(copy);
              }
            }

            const skeleton = document.querySelector('[data-startup-skeleton="true"]');
            const taskColumnCount = document.querySelectorAll('[data-task-id]').length;
            if (skeleton) {
              capture.sawSkeleton = true;
              const columnCount = skeleton.childElementCount;
              if (
                capture.skeletonColumnCounts[capture.skeletonColumnCounts.length - 1] !==
                columnCount
              ) {
                capture.skeletonColumnCounts.push(columnCount);
              }
            } else if (capture.sawSkeleton && taskColumnCount === 0) {
              capture.sawZeroColumnFrameAfterSkeleton = true;
            }

            if (!capture.placeholderSeenBeforeLiveReady) {
              const liveReady = document.querySelector('[data-terminal-live-render-ready="true"]');
              if (!liveReady && document.querySelector('[data-terminal-placeholder-tail="true"]')) {
                capture.placeholderSeenBeforeLiveReady = true;
              }
            }
          }

          const observer = new MutationObserver(sample);
          function startObserving(): void {
            observer.observe(document.documentElement, {
              attributes: true,
              childList: true,
              subtree: true,
            });
            sample();
          }

          if (document.documentElement) {
            startObserving();
          } else {
            document.addEventListener(
              'readystatechange',
              () => {
                startObserving();
              },
              { once: true },
            );
          }
        }, FORBIDDEN_FIRST_RUN_COPY);
      },
    });

    await waitForAppShellVisible(page);
    await browserLab.waitForTerminalReady(page);
    await expect(page.locator('[data-task-id]')).toHaveCount(2);

    // The last-known workspace shape is persisted on a 1s debounce; the
    // skeleton on reload depends on it.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const raw = window.localStorage.getItem(
              `parallel-code:workspace-shape:v1:${window.location.origin}`,
            );
            if (!raw) {
              return null;
            }

            try {
              return (JSON.parse(raw) as { taskNames?: string[] }).taskNames?.length ?? null;
            } catch {
              return null;
            }
          }),
        { timeout: 10_000 },
      )
      .toBe(2);

    await page.reload();
    await waitForAppShellVisible(page);
    await expect(page.locator('[data-task-id]')).toHaveCount(2, { timeout: 20_000 });
    await browserLab.waitForTerminalReady(page);

    const capture = await readStartupSkeletonCapture(page);
    expect(capture.sawForbiddenCopy).toEqual([]);
    expect(capture.sawSkeleton).toBe(true);
    expect(capture.skeletonColumnCounts).toContain(2);
    expect(capture.sawZeroColumnFrameAfterSkeleton).toBe(false);
    expect(capture.placeholderSeenBeforeLiveReady).toBe(true);
  });
});
