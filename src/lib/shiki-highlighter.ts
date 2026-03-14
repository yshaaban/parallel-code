import type { BundledLanguage, BundledTheme, Highlighter, SpecialLanguage } from 'shiki';

const THEME: BundledTheme = 'github-dark';

const EXTENSION_LANGUAGES: Record<string, BundledLanguage> = {
  bash: 'shellscript',
  c: 'c',
  cpp: 'cpp',
  css: 'css',
  dockerfile: 'dockerfile',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shellscript',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript',
};

const BASENAME_LANGUAGES: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

const PRELOADED_LANGUAGES: BundledLanguage[] = [
  ...new Set([...Object.values(EXTENSION_LANGUAGES), ...Object.values(BASENAME_LANGUAGES)]),
];

let highlighterPromise: Promise<Highlighter> | undefined;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return character;
    }
  });
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((module) =>
      module.createHighlighter({
        themes: [THEME],
        langs: PRELOADED_LANGUAGES,
      }),
    );
  }

  return highlighterPromise;
}

function getEffectiveLanguage(
  highlighter: Highlighter,
  lang: string,
): BundledLanguage | SpecialLanguage {
  const loadedLanguages = highlighter.getLoadedLanguages() as string[];
  if (loadedLanguages.includes(lang) || lang === 'plaintext') {
    return lang as BundledLanguage;
  }

  return 'plaintext';
}

function renderTokenContent(content: string, color: string | undefined): string {
  const escaped = escapeHtml(content);
  if (!color) {
    return escaped;
  }

  return `<span style="color:${color}">${escaped}</span>`;
}

export function detectLang(filePath: string): string {
  const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
  const specialLanguage = BASENAME_LANGUAGES[basename];
  if (specialLanguage) {
    return specialLanguage;
  }

  const extension = basename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext';
}

export async function highlightLines(code: string, lang: string): Promise<string[]> {
  const highlighter = await getHighlighter();

  const { tokens } = highlighter.codeToTokens(code, {
    lang: getEffectiveLanguage(highlighter, lang),
    theme: THEME,
  });

  return tokens.map((line) =>
    line.map((token) => renderTokenContent(token.content, token.color)).join(''),
  );
}
