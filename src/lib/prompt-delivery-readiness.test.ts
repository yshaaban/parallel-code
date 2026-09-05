import { describe, expect, it } from 'vitest';

import {
  capPromptDeliveryEvidence,
  classifyPromptDeliveryEvidence,
  type PromptDeliveryReadyCandidate,
} from './prompt-delivery-readiness.js';

function classify(
  tail: string,
  overrides: Partial<Parameters<typeof classifyPromptDeliveryEvidence>[0]> = {},
) {
  return classifyPromptDeliveryEvidence({
    generation: 1,
    lastOutputAtMs: 0,
    nowMs: 2_000,
    supervisionState: 'idle-at-prompt',
    tail,
    ...overrides,
  });
}

function stableCandidate(tail: string): PromptDeliveryReadyCandidate {
  const first = classify(tail, { nowMs: 1_000 });
  expect(first.readyCandidate).toBeDefined();
  return first.readyCandidate as PromptDeliveryReadyCandidate;
}

describe('prompt delivery readiness evidence', () => {
  it('caps the newest evidence to 64 KiB without splitting Unicode', () => {
    const capped = capPromptDeliveryEvidence(`old${'🚀'.repeat(20_000)}`);
    expect(capped.byteLength).toBeLessThanOrEqual(65_536);
    expect(capped.text).not.toContain('\ufffd');
    expect(new TextEncoder().encode(capped.text).length).toBe(capped.byteLength);
  });

  it.each([
    ['a🚀', 5, 'a🚀'],
    ['a🚀', 4, '🚀'],
    ['a🚀', 3, ''],
    ['aé', 2, 'é'],
    ['a\ud800', 3, '\ud800'],
    ['a\ud800', 2, ''],
  ])('matches UTF-8 suffix boundaries for %j at %i bytes', (text, maxBytes, expected) => {
    const capped = capPromptDeliveryEvidence(text, maxBytes);
    expect(capped.text).toBe(expected);
    expect(new TextEncoder().encode(capped.text).length).toBe(capped.byteLength);
    expect(capped.byteLength).toBeLessThanOrEqual(maxBytes);
  });

  it('blocks a blank current frame after clear/home even when an old prompt existed', () => {
    expect(classify(`❯\u001b[2J\u001b[H`).kind).toBe('startup');
  });

  it('uses the current carriage-return redraw rather than a stale prompt', () => {
    expect(classify('❯\rLoading MCP server').kind).toBe('startup');
  });

  it.each(['Starting MCP server github', 'Starting MCP servers github, docs'])(
    'recognizes singular/plural startup text: %s',
    (tail) => {
      expect(classify(tail, { supervisionState: 'restoring' }).kind).toBe('startup');
    },
  );

  it('requires two stable observations and 1.5 seconds of quiescence', () => {
    const tail = 'ready\n❯';
    const previousReadyCandidate = stableCandidate(tail);
    expect(
      classify(tail, {
        lastOutputAtMs: 700,
        nowMs: 1_500,
        previousReadyCandidate,
      }).kind,
    ).toBe('startup');
    expect(
      classify(tail, {
        lastOutputAtMs: 0,
        nowMs: 1_500,
        previousReadyCandidate,
      }).kind,
    ).toBe('ready');
  });

  it('never admits a question or selection dialog as ready', () => {
    expect(classify('Do you want to continue?').kind).toBe('awaiting-input');
    expect(classify('Choose an option\n›').kind).toBe('awaiting-input');
  });

  it('proves delivery from echo or authoritative activity', () => {
    expect(
      classify('❯ ship it', {
        postWrite: {
          activityTransitionObserved: false,
          promptPrefix: 'ship it',
          returnedToReadySnapshot: false,
        },
      }).kind,
    ).toBe('delivered');
    expect(
      classify('working', {
        postWrite: {
          activityTransitionObserved: true,
          promptPrefix: 'ship it',
          returnedToReadySnapshot: false,
        },
        supervisionState: 'active',
      }).kind,
    ).toBe('delivered');
  });

  it('proves absence only after the same stable ready snapshot returns', () => {
    const tail = '❯';
    const previousReadyCandidate = stableCandidate(tail);
    expect(
      classify(tail, {
        nowMs: 1_500,
        postWrite: {
          activityTransitionObserved: false,
          promptPrefix: 'missing prompt',
          returnedToReadySnapshot: true,
        },
        previousReadyCandidate,
      }).kind,
    ).toBe('absence-proven');
    expect(
      classify(tail, {
        nowMs: 1_500,
        postWrite: {
          activityTransitionObserved: false,
          promptPrefix: 'missing prompt',
          returnedToReadySnapshot: false,
        },
        previousReadyCandidate,
      }).kind,
    ).toBe('ready');
  });
});
