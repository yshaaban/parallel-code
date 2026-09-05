import type { Page } from '@playwright/test';

import { expect, test } from './harness/fixtures.js';
import {
  getBrowserPrimaryModifier,
  type BrowserPrimaryModifier,
} from './harness/browser-platform.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

interface TerminalPoint {
  x: number;
  y: number;
}

async function clickTerminalPoint(
  page: Page,
  point: TerminalPoint,
  modifier?: BrowserPrimaryModifier,
): Promise<void> {
  if (!modifier) {
    await page.mouse.click(point.x, point.y);
    return;
  }
  await page.keyboard.down(modifier);
  try {
    await page.mouse.click(point.x, point.y);
  } finally {
    await page.keyboard.up(modifier);
  }
}

async function hoverTerminalPoint(
  page: Page,
  target: 'continuation' | 'first',
): Promise<TerminalPoint> {
  const terminalLinkSurface = page
    .locator('[data-terminal-status]')
    .first()
    .locator('.xterm-screen');
  let currentPoint: TerminalPoint | null = null;
  await expect
    .poll(
      async () => {
        const screen = await terminalLinkSurface.boundingBox();
        if (!screen) return false;
        currentPoint = (await getWrappedPathPoints(page))[target];
        await page.mouse.move(screen.x + screen.width - 2, screen.y + screen.height - 2);
        await page.mouse.move(currentPoint.x, currentPoint.y, { steps: 8 });
        return terminalLinkSurface.evaluate((element) =>
          element.classList.contains('xterm-cursor-pointer'),
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  if (!currentPoint) throw new Error(`Expected a hover point for the ${target} row`);
  return currentPoint;
}

async function getWrappedPathPoints(page: Page): Promise<{
  continuation: TerminalPoint;
  first: TerminalPoint;
}> {
  return page
    .locator('[data-terminal-status]')
    .first()
    .evaluate((terminalRoot) => {
      const rows = Array.from(terminalRoot.querySelectorAll('.xterm-rows > div'));
      const contributingRows = rows.filter((row) =>
        (row.textContent ?? '').match(/(?:ASCII|\.\/|README\.md)/u),
      );
      const firstRow = contributingRows.find((row) => (row.textContent ?? '').includes('ASCII'));
      const continuationRow = [...contributingRows]
        .reverse()
        .find((row) => (row.textContent ?? '').includes('README.md'));
      const measure = Array.from(terminalRoot.querySelectorAll('.xterm-char-measure-element')).find(
        (element) => (element.textContent?.length ?? 0) > 0,
      );
      const measureCharacterCount = Array.from(measure?.textContent ?? '').length;
      const cellWidth =
        measureCharacterCount > 0
          ? (measure?.getBoundingClientRect().width ?? 0) / measureCharacterCount
          : 0;
      if (!(firstRow instanceof HTMLElement) || !(continuationRow instanceof HTMLElement)) {
        throw new Error('Expected wrapped path rows in the xterm DOM renderer');
      }
      if (cellWidth <= 0) {
        throw new Error('Expected a measurable xterm character cell');
      }

      const toPoint = (row: HTMLElement, marker: string): TerminalPoint => {
        const text = row.textContent ?? '';
        const textOffset = text.indexOf(marker);
        if (textOffset < 0) {
          throw new Error(`Expected terminal row marker: ${marker}`);
        }
        const column = Array.from(text.slice(0, textOffset)).reduce(
          (cellCount, character) => cellCount + (character === '界' ? 2 : 1),
          0,
        );
        const rect = row.getBoundingClientRect();
        return {
          x: rect.left + (column + 1.5) * cellWidth,
          y: rect.top + rect.height / 2,
        };
      };

      return {
        continuation: toPoint(continuationRow, 'README.md'),
        first: toPoint(firstRow, './'),
      };
    });
}

test.describe('browser-lab wrapped terminal Markdown links', () => {
  test.use({ scenario: createInteractiveNodeScenario() });

  test('opens one same-worktree link from its first or continuation row', async ({
    browser,
    browserLab,
    request,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await browserLab.openSession(browser, {
      displayName: 'Wrapped Link Tester',
      prepareContext: async (browserContext) => {
        await browserContext.addInitScript(() => {
          const originalGetContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function getContextWithoutWebgl(
            contextId: string,
            ...args: unknown[]
          ): RenderingContext | null {
            if (
              contextId === 'webgl' ||
              contextId === 'webgl2' ||
              contextId === 'experimental-webgl'
            ) {
              return null;
            }
            return originalGetContext.call(this, contextId, ...args);
          };
        });
      },
    });

    try {
      await page.setViewportSize({ height: 720, width: 760 });
      await browserLab.waitForTerminalReady(page);
      const repeatedPath = `${'./'.repeat(60)}README.md`;
      await browserLab.runInTerminal(
        page,
        `console.clear(); console.log("ASCII 界界 ${repeatedPath}")`,
      );
      await browserLab.waitForAgentScrollback(request, browserLab.server.agentId, repeatedPath);
      const terminalRoot = page.locator('[data-terminal-status]').first();
      await expect(terminalRoot.locator('.xterm-rows')).toContainText('README.md');

      let continuationPoint = await hoverTerminalPoint(page, 'continuation');
      await clickTerminalPoint(page, continuationPoint);
      await expect(page.getByRole('dialog', { name: 'Plan viewer: README.md' })).toBeHidden();

      const primaryModifier = await getBrowserPrimaryModifier(page);
      continuationPoint = await hoverTerminalPoint(page, 'continuation');
      await clickTerminalPoint(page, continuationPoint, primaryModifier);
      const viewer = page.getByRole('dialog', { name: 'Plan viewer: README.md' });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByText('Browser Lab Fixture')).toBeVisible();
      await viewer.getByRole('button', { name: 'Close plan viewer' }).click();
      await expect(viewer).toBeHidden();

      const firstPoint = await hoverTerminalPoint(page, 'first');
      await clickTerminalPoint(page, firstPoint, primaryModifier);
      await expect(page.getByRole('dialog', { name: 'Plan viewer: README.md' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
