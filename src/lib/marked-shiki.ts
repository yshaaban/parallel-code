import { Marked, type Tokens } from 'marked';
import { createEffect, createSignal } from 'solid-js';

import { highlightLines } from './shiki-highlighter';

interface CodeBlock {
  lang: string;
  text: string;
}

interface MarkdownRendererContext {
  parser?: {
    parseInline?: (...args: unknown[]) => string;
  };
}

interface TokenLike {
  items?: { tokens?: TokenLike[] }[];
  lang?: string;
  text?: string;
  tokens?: TokenLike[];
  type: string;
}

const SAFE_MARKDOWN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function collectCodeTokens(tokens: ReadonlyArray<TokenLike>, output: CodeBlock[]): void {
  for (const token of tokens) {
    if (token.type === 'code') {
      output.push({
        lang: token.lang ?? '',
        text: token.text ?? '',
      });
    }

    if (Array.isArray(token.tokens)) {
      collectCodeTokens(token.tokens, output);
    }

    if (!Array.isArray(token.items)) {
      continue;
    }

    for (const item of token.items) {
      if (Array.isArray(item.tokens)) {
        collectCodeTokens(item.tokens, output);
      }
    }
  }
}

function renderCodeBlockHtml(
  lines: string[] | undefined,
  lang: string | undefined,
  text: string | undefined,
): string {
  const langAttribute = lang ? ` data-lang="${escapeAttr(lang)}"` : '';
  if (!lines) {
    return `<pre class="shiki-block"${langAttribute}><code>${escapeHtml(text ?? '')}</code></pre>`;
  }

  return `<pre class="shiki-block"${langAttribute}><code>${lines.join('\n')}</code></pre>`;
}

function sanitizeMarkdownUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!URL_SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    return SAFE_MARKDOWN_PROTOCOLS.has(parsed.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function renderInlineTokenHtml(
  context: MarkdownRendererContext,
  token: { text?: string; tokens?: readonly Tokens.Generic[] },
): string {
  if (Array.isArray(token.tokens) && token.tokens.length > 0) {
    return context.parser?.parseInline?.(token.tokens) ?? token.text ?? '';
  }

  return token.text ?? '';
}

function createMarkdownRenderer(highlightedBlocks?: ReadonlyArray<string[] | undefined>) {
  let blockIndex = 0;

  return {
    code(token: Tokens.Code): string {
      const lines = highlightedBlocks?.[blockIndex];
      blockIndex += 1;
      return renderCodeBlockHtml(lines, token.lang, token.text);
    },
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    image(token: Tokens.Image): string {
      const src = sanitizeMarkdownUrl(token.href);
      if (!src) {
        return escapeHtml(token.text);
      }

      const titleAttribute = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(token.text)}"${titleAttribute}>`;
    },
    link(token: Tokens.Link): string {
      const href = sanitizeMarkdownUrl(token.href);
      const text = renderInlineTokenHtml(this as MarkdownRendererContext, token);
      if (!href) {
        return text;
      }

      const titleAttribute = token.title ? ` title="${escapeAttr(token.title)}"` : '';
      return `<a href="${escapeAttr(href)}"${titleAttribute}>${text}</a>`;
    },
  };
}

function createMarkdownParser(highlightedBlocks?: ReadonlyArray<string[] | undefined>): Marked {
  const marked = new Marked();
  marked.use({
    renderer: createMarkdownRenderer(highlightedBlocks),
  });
  return marked;
}

export function renderMarkdownSafely(markdown: string): string {
  const marked = createMarkdownParser();
  const tokens = marked.lexer(markdown);
  return marked.parser(tokens);
}

export async function renderMarkdownWithHighlighting(markdown: string): Promise<string> {
  const marked = createMarkdownParser();
  const tokens = marked.lexer(markdown);
  const codeBlocks: CodeBlock[] = [];

  collectCodeTokens(tokens as TokenLike[], codeBlocks);

  const highlightedBlocks = await Promise.all(
    codeBlocks.map(({ lang, text }) => highlightLines(text, lang || 'plaintext')),
  );

  const highlightedMarked = createMarkdownParser(highlightedBlocks);
  return highlightedMarked.parser(tokens);
}

export function createHighlightedMarkdown(source: () => string | undefined): () => string {
  const [html, setHtml] = createSignal('');
  let generation = 0;

  createEffect(() => {
    const content = source();
    if (!content) {
      setHtml('');
      return;
    }

    const nextGeneration = ++generation;
    renderMarkdownWithHighlighting(content)
      .then((result) => {
        if (nextGeneration === generation) {
          setHtml(result);
        }
      })
      .catch(() => {
        if (nextGeneration === generation) {
          setHtml(renderMarkdownSafely(content));
        }
      });
  });

  return html;
}
