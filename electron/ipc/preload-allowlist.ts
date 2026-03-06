const ALLOWLIST_PATTERN = /const ALLOWED_CHANNELS = new Set\(\[(?<entries>[\s\S]*?)\]\);/;
const QUOTED_LITERAL_PATTERN = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;

function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(['"\\])/g, '$1');
}

export function parsePreloadAllowedChannels(source: string): Set<string> {
  const match = source.match(ALLOWLIST_PATTERN);
  const entries = match?.groups?.entries;

  if (!entries) {
    throw new Error('Failed to locate ALLOWED_CHANNELS in preload source');
  }

  const channels = new Set<string>();
  for (const literal of entries.matchAll(QUOTED_LITERAL_PATTERN)) {
    const raw = literal[1] ?? literal[2];
    if (raw !== undefined) {
      channels.add(unescapeLiteral(raw));
    }
  }

  return channels;
}

export function diffPreloadAllowedChannels(
  source: string,
  expectedChannels: Iterable<string>,
): { allowed: Set<string>; missing: string[]; extra: string[] } {
  const allowed = parsePreloadAllowedChannels(source);
  const expected = new Set(expectedChannels);

  const missing = [...expected].filter((channel) => !allowed.has(channel)).sort();
  const extra = [...allowed].filter((channel) => !expected.has(channel)).sort();

  return { allowed, missing, extra };
}
