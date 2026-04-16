// @vitest-environment jsdom
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

  it('escapes raw html instead of rendering active markup', async () => {
    const html = await renderMarkdownWithHighlighting('<script>alert(1)</script>');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops unsafe javascript links while preserving safe links', async () => {
    const html = await renderMarkdownWithHighlighting(
      ['[safe](https://example.com)', '', '[unsafe](javascript:alert(1))'].join('\n'),
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).toContain('>unsafe<');
  });

  it('drops protocol-relative links instead of treating them as local relative paths', async () => {
    const html = await renderMarkdownWithHighlighting('[unsafe](//example.com/guide.md)');

    expect(html).not.toContain('href="//example.com/guide.md"');
    expect(html).toContain('>unsafe<');
  });

  it('keeps Mermaid fences as normal code blocks unless a caller opts in', async () => {
    const html = await renderMarkdownWithHighlighting(
      ['```mermaid', 'graph TD;', '```'].join('\n'),
    );

    expect(html).toContain('class="shiki-block"');
    expect(html).toContain('data-lang="mermaid"');
    expect(html).not.toContain('plan-mermaid-block');
  });

  it('lets local owners override special code blocks without widening global markdown behavior', async () => {
    const html = await renderMarkdownWithHighlighting(
      ['```mermaid', 'graph TD;', '```'].join('\n'),
      {
        renderSpecialCodeBlock: (block) =>
          block.lang === 'mermaid' ? `<div class="test-mermaid-block">${block.text}</div>` : null,
      },
    );

    expect(html).toContain('class="test-mermaid-block"');
    expect(html).toContain('graph TD;');
    expect(html).not.toContain('data-lang="mermaid"');
  });
});
