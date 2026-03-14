import { Marked, type Tokens } from 'marked';
import { createEffect, createSignal } from 'solid-js';

import { highlightLines } from './shiki-highlighter';

interface CodeBlock {
  lang: string;
  text: string;
}

interface TokenLike {
  items?: { tokens?: TokenLike[] }[];
  lang?: string;
  text?: string;
  tokens?: TokenLike[];
  type: string;
}

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

export async function renderMarkdownWithHighlighting(markdown: string): Promise<string> {
  const marked = new Marked();
  const tokens = marked.lexer(markdown);
  const codeBlocks: CodeBlock[] = [];

  collectCodeTokens(tokens as TokenLike[], codeBlocks);

  const highlightedBlocks = await Promise.all(
    codeBlocks.map(({ lang, text }) => highlightLines(text, lang || 'plaintext')),
  );

  let blockIndex = 0;
  marked.use({
    renderer: {
      code(token: Tokens.Code): string {
        const lines = highlightedBlocks[blockIndex];
        blockIndex += 1;
        return renderCodeBlockHtml(lines, token.lang, token.text);
      },
    },
  });

  return marked.parser(tokens);
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
          setHtml(new Marked().parse(content, { async: false }) as string);
        }
      });
  });

  return html;
}
