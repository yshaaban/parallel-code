import type { Page } from '@playwright/test';

import { isMacUserAgent } from '../../../src/lib/platform.js';

export type BrowserPrimaryModifier = 'Control' | 'Meta';
export type BrowserPrimaryFindChord = 'Control+f' | 'Meta+f';

export async function getBrowserPrimaryModifier(page: Page): Promise<BrowserPrimaryModifier> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const isMac = isMacUserAgent(userAgent);
  return isMac ? 'Meta' : 'Control';
}

export async function getBrowserPrimaryFindChord(page: Page): Promise<BrowserPrimaryFindChord> {
  return `${await getBrowserPrimaryModifier(page)}+f`;
}
