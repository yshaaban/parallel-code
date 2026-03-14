// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { getPlanSelection } from './plan-selection';

describe('getPlanSelection', () => {
  it('returns 1-based block line numbers and the nearest heading', () => {
    document.body.innerHTML = `
      <div id="container">
        <h1>Heading</h1>
        <p>First paragraph</p>
        <p>Second paragraph</p>
      </div>
    `;

    const container = document.getElementById('container') as HTMLElement | null;
    expect(container).not.toBeNull();

    if (!container) {
      return;
    }

    const paragraph = container.querySelectorAll('p')[0];
    expect(paragraph).toBeTruthy();

    if (!paragraph?.firstChild) {
      return;
    }

    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 'First paragraph'.length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(getPlanSelection(container, 'plan.md')).toEqual({
      source: 'plan.md',
      selectedText: 'First paragraph',
      nearestHeading: 'Heading',
      startLine: 2,
      endLine: 2,
    });
  });
});
