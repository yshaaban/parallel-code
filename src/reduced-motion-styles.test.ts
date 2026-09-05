import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

function listComponentSources(directory = 'src/components'): string[] {
  return readdirSync(path.resolve(process.cwd(), directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listComponentSources(relativePath);
      }
      return entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')
        ? [relativePath]
        : [];
    },
  );
}

describe('reduced-motion presentation contract', () => {
  it('keeps one final main-app policy with an explicit nonessential animation list', () => {
    const styles = readSource('src/styles.css');
    const mediaMarker = '@media (prefers-reduced-motion: reduce)';
    const markerIndexes = [
      ...styles.matchAll(new RegExp(mediaMarker.replace(/[()]/gu, '\\$&'), 'gu')),
    ];

    expect(markerIndexes).toHaveLength(1);
    const marker = markerIndexes[0];
    if (!marker) {
      throw new Error('Missing main reduced-motion media block');
    }
    const reducedMotion = styles.slice(marker.index);
    expect(reducedMotion).toContain('scroll-behavior: auto !important');
    expect(reducedMotion).toContain('transition-duration: 0.01ms !important');

    for (const selector of [
      '.task-appearing',
      '.task-item-appearing',
      '.task-removing',
      '.task-item-removing',
      '.dialog-overlay',
      '.exit-badge',
      '.status-dot-pulse',
      '.askcode-loading-pulse',
    ]) {
      expect(reducedMotion).toContain(selector);
    }

    expect(reducedMotion).toContain('animation: none !important');
    expect(reducedMotion).not.toMatch(/\.inline-spinner\s*(?:,|\{)/u);
    expect(styles.lastIndexOf(mediaMarker)).toBeGreaterThan(styles.lastIndexOf('@keyframes'));
  });

  it('preserves static status and terminal acknowledgement cues', () => {
    const styles = readSource('src/styles.css');
    const statusDot = readSource('src/components/StatusDot.tsx');
    const activity = readSource('src/components/TaskActivityIndicator.tsx');
    const askCode = readSource('src/components/AskCodeCard.tsx');

    expect(styles).toContain('.status-dot-ring');
    expect(styles).toContain('outline: 1px solid currentColor');
    expect(styles).toContain("[data-terminal-input-ack='true']");
    expect(styles).toContain('outline-color: color-mix(');
    expect(statusDot).toContain('status-dot-pulse status-dot-ring');
    expect(activity).toContain('status-dot-pulse status-dot-ring');

    expect(askCode).toContain('class="askcode-loading-pulse"');
    expect(askCode).toContain('Still receiving response');
    expect(askCode).toContain('aria-hidden="true"');
    expect(askCode).not.toContain("animation: 'askcode-pulse");
  });

  it('keeps runtime-specific reduction policies for remote and Arena builds', () => {
    const remote = readSource('src/remote/index.html');
    const arenaFiles = [
      'src/arena/arena-shared.css',
      'src/arena/arena-battle.css',
      'src/arena/arena-countdown.css',
      'src/arena/arena-results.css',
    ].map(readSource);

    expect(remote).toContain('@media (prefers-reduced-motion: reduce)');
    expect(remote).toContain('animation-duration: 0.01ms !important');
    expect(remote).toContain('transition-duration: 0.01ms !important');
    for (const source of arenaFiles) {
      expect(source).toContain('@media (prefers-reduced-motion: reduce)');
    }
  });

  it('keeps every functional spinner animated but decorative to assistive technology', () => {
    const spinnerTags = listComponentSources().flatMap((relativePath) => {
      const source = readSource(relativePath);
      return [...source.matchAll(/<span\b(?=[^>]*class="inline-spinner")[^>]*>/gsu)].map(
        (match) => ({ relativePath, tag: match[0] }),
      );
    });

    expect(spinnerTags.length).toBeGreaterThan(0);
    for (const { relativePath, tag } of spinnerTags) {
      expect(tag, relativePath).toContain('aria-hidden="true"');
    }
  });

  it('keeps the one-shot appearance preference helper local and side-effect free', () => {
    const helper = readSource('src/lib/reduced-motion.ts');

    expect(helper).toContain('window.matchMedia(REDUCED_MOTION_QUERY).matches');
    expect(helper).not.toMatch(/addEventListener|addListener|setTimeout|setInterval/u);
    expect(helper).not.toMatch(/store|invoke|fetch|localStorage|sessionStorage/u);
  });
});
