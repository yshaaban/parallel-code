import { describe, expect, it } from 'vitest';

import { renderMarkdownWithHighlighting } from './marked-shiki';

describe('renderMarkdownWithHighlighting', () => {
  it('renders fenced code blocks with Shiki markup', async () => {
    const html = await renderMarkdownWithHighlighting(
      ['# Plan', '', '```ts', 'const value = 42;', '```'].join('\n'),
    );

    expect(html).toContain('class="shiki-block"');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('<span style="color:');
    expect(html).toContain('value');
    expect(html).toContain('42');
  }, 15_000);
});
