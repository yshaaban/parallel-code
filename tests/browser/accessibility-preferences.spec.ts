import type { Locator, Page } from '@playwright/test';
import { expect, test } from './harness/fixtures.js';
import { createInteractiveNodeScenario } from './harness/scenarios.js';

const scenario = createInteractiveNodeScenario();
scenario.taskGitIsolation = 'current-branch';

test.use({ scenario });

async function getFocusEvidence(locator: Locator): Promise<{
  boxShadow: string;
  outlineStyle: string;
  outlineWidth: number;
}> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
    };
  });
}

function expectVisibleFocus(evidence: {
  boxShadow: string;
  outlineStyle: string;
  outlineWidth: number;
}): void {
  expect(
    (evidence.outlineStyle !== 'none' && evidence.outlineWidth >= 2) ||
      evidence.boxShadow !== 'none',
  ).toBe(true);
}

async function installFocusProbe(page: Page): Promise<Locator> {
  await page.locator('.app-shell').evaluate((appShell) => {
    document.querySelector('#accessibility-focus-anchor')?.remove();
    document.querySelector('#accessibility-focus-probe')?.remove();
    const anchor = document.createElement('button');
    anchor.id = 'accessibility-focus-anchor';
    anchor.textContent = 'Accessibility focus anchor';
    anchor.style.position = 'fixed';
    anchor.style.inset = '8px auto auto -10000px';
    const probe = document.createElement('button');
    probe.id = 'accessibility-focus-probe';
    probe.textContent = 'Accessibility focus probe';
    probe.style.position = 'fixed';
    probe.style.inset = '8px auto auto 8px';
    probe.style.zIndex = '10000';
    appShell.prepend(anchor, probe);
  });
  return page.locator('#accessibility-focus-probe');
}

test('keeps keyboard focus, reduced motion, static cues, and denial feedback usable', async ({
  browser,
  browserLab,
}) => {
  const { context, page } = await browserLab.openSession(browser, {
    displayName: 'Accessibility Preferences',
  });

  try {
    await browserLab.waitForTerminalReady(page);

    const probe = await installFocusProbe(page);
    await probe.click();
    expect(await probe.evaluate((element) => element.matches(':focus-visible'))).toBe(false);

    await page.locator('#accessibility-focus-anchor').focus();
    await page.keyboard.press('Tab');
    await expect(probe).toBeFocused();
    expect(await probe.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    expectVisibleFocus(await getFocusEvidence(probe));

    // Generated xterm targets suppress their tiny internal ring only while the first-party shell
    // supplies a visible focus-within perimeter.
    const terminalInput = page.locator('.focusable-panel .xterm textarea').first();
    await terminalInput.focus();
    const terminalFocus = await terminalInput.evaluate((element) => {
      const internal = getComputedStyle(element);
      const shell = element.closest('.focusable-panel');
      const perimeter = shell ? getComputedStyle(shell, '::after') : null;
      return {
        internalOutline: internal.outlineStyle,
        perimeterStyle: perimeter?.borderTopStyle ?? 'none',
        perimeterWidth: Number.parseFloat(perimeter?.borderTopWidth ?? '0') || 0,
      };
    });
    expect(terminalFocus.internalOutline).toBe('none');
    expect(terminalFocus.perimeterStyle).toBe('solid');
    expect(terminalFocus.perimeterWidth).toBeGreaterThanOrEqual(2);

    // A project-root task has no managed worktree to merge. The shortcut must explain that in a
    // polite live region instead of opening an unusable dialog.
    await page.keyboard.press('Control+Shift+M');
    const denial = page.getByRole('status').filter({
      hasText: 'This task already uses the project branch; there is no task worktree to merge.',
    });
    await expect(denial).toBeVisible();
    await expect(denial).toHaveAttribute('data-app-notification-kind', 'warning');
    await denial.click();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await browserLab.waitForTerminalReady(page);

    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    await expect(page.locator('.task-appearing')).toHaveCount(0);
    await expect(page.locator('.task-item-appearing')).toHaveCount(0);

    const reducedMotionEvidence = await page.locator('.app-shell').evaluate((appShell) => {
      const spinner = document.createElement('span');
      spinner.className = 'inline-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      appShell.append(spinner);

      const status = document.createElement('span');
      status.className = 'status-dot-pulse status-dot-ring';
      status.style.color = 'var(--accent)';
      appShell.append(status);

      const transitionProbe = document.createElement('button');
      transitionProbe.style.transition = 'transform 3s ease';
      appShell.append(transitionProbe);

      const spinnerStyle = getComputedStyle(spinner);
      const statusStyle = getComputedStyle(status);
      const transitionStyle = getComputedStyle(transitionProbe);
      return {
        spinnerAnimation: spinnerStyle.animationName,
        statusAnimation: statusStyle.animationName,
        statusOutlineStyle: statusStyle.outlineStyle,
        statusOutlineWidth: Number.parseFloat(statusStyle.outlineWidth) || 0,
        transitionDurationSeconds:
          Number.parseFloat(transitionStyle.transitionDuration) || Number.POSITIVE_INFINITY,
      };
    });
    expect(reducedMotionEvidence.spinnerAnimation).toContain('spinnerSpin');
    expect(reducedMotionEvidence.statusAnimation).toBe('none');
    expect(reducedMotionEvidence.statusOutlineStyle).toBe('solid');
    expect(reducedMotionEvidence.statusOutlineWidth).toBeGreaterThanOrEqual(1);
    expect(reducedMotionEvidence.transitionDurationSeconds).toBeCloseTo(0.00001, 8);

    await page.getByRole('button', { name: /^Settings/ }).click();
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(settingsDialog).toBeVisible();
    expect(
      await page
        .locator('.dialog-overlay')
        .last()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { animationName: style.animationName, contentVisible: style.display !== 'none' };
        }),
    ).toEqual({ animationName: 'none', contentVisible: true });
    await page.keyboard.press('Escape');

    const arenaButton = page.getByRole('button', { name: 'Arena', exact: true });
    if ((await arenaButton.count()) === 0) {
      await page.getByRole('button', { name: 'Progress', exact: true }).click();
    }
    await arenaButton.scrollIntoViewIfNeeded();
    await arenaButton.click();
    const competitorInput = page.locator('.arena-competitor-input').first();
    await expect(competitorInput).toBeVisible();

    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await competitorInput.focus();
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    expectVisibleFocus(await getFocusEvidence(competitorInput));
  } finally {
    await context.close();
  }
});
