interface PortDetectionMatch {
  host: string | null;
  port: number;
  protocol: 'http' | 'https';
  suggestion: string;
}

const TERMINAL_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  'g',
);
const TERMINAL_CONTROL_CHARACTER_PATTERN = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]`,
  'g',
);
const TERMINAL_BRACKET_FRAGMENT_PATTERN = /(?:\[(?:\d|;)+(?:[A-Z]|m))+$/u;
const URL_TRAILING_NOISE_PATTERN = /[^\w\-._~:/?#[\]@!$&'()*+,;=%]+$/u;
const URL_SAFE_CHARACTER_PATTERN = /^[\w\-._~:/?#[\]@!$&'()*+,;=%]$/u;
const URL_HARD_STOP_CHARACTERS = new Set(['"', "'", '<', '>', '|', '\\', '`', '{', '}']);

const URL_PATTERNS = [
  /\b(https?):\/\/(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|::1):(\d{2,5})(?:\/[^\s]*)?/gi,
  /\b(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|::1):(\d{2,5})(?:\/[^\s]*)?/gi,
] as const;

interface ListeningPattern {
  pattern: RegExp;
  suggestion: (port: number) => string;
}

const LISTENING_PATTERNS: ListeningPattern[] = [
  {
    pattern: /\blistening on\b(?:[^0-9]+port)?[^0-9]+(\d{2,5})\b/gi,
    suggestion: (port) => `Listening on port ${port}`,
  },
  {
    pattern: /\bservers?\b(?:[^0-9]+\bstarted\b)?[^0-9]+\bport\b[^0-9]+(\d{2,5})\b/gi,
    suggestion: (port) => `Port ${port}`,
  },
];

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function pushUniqueDetection(
  results: PortDetectionMatch[],
  seenPorts: Set<number>,
  host: string | null,
  port: number,
  protocol: 'http' | 'https',
  suggestion: string,
): void {
  if (!isValidPort(port) || seenPorts.has(port)) {
    return;
  }

  seenPorts.add(port);
  results.push({
    host,
    port,
    protocol,
    suggestion,
  });
}

function normalizeDetectedHost(host: string | undefined): string | null {
  if (!host) {
    return null;
  }

  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }

  return host;
}

function stripTerminalControlSequences(input: string): string {
  return input
    .replace(TERMINAL_ESCAPE_SEQUENCE_PATTERN, '')
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '');
}

function trimTrailingSuggestionNoise(input: string): string {
  return input.replace(URL_TRAILING_NOISE_PATTERN, '');
}

function trimTrailingTerminalBracketFragments(input: string): string {
  return input.replace(TERMINAL_BRACKET_FRAGMENT_PATTERN, '');
}

function trimTruncatedUrlPath(input: string): string {
  const queryIndex = input.search(/[?#]/u);
  const suffixStart = queryIndex >= 0 ? queryIndex : input.length;
  const suffix = input.slice(suffixStart);
  const withoutSuffix = input.slice(0, suffixStart);
  const lastSlashIndex = withoutSuffix.lastIndexOf('/');

  if (lastSlashIndex < 0) {
    return input;
  }

  const authority = withoutSuffix.slice(0, lastSlashIndex);
  const lastSegment = withoutSuffix.slice(lastSlashIndex + 1);

  if (lastSegment.length === 0) {
    return `${authority}${suffix}`;
  }

  if (!/[A-Za-z]/u.test(lastSegment)) {
    return `${authority}${suffix}`;
  }

  return input;
}

function trimShellDelimitedUrlSuffix(input: string): string {
  let result = '';
  let sawQuery = false;
  let truncated = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    const nextCharacter = input[index + 1] ?? '';

    if (/\s/u.test(character)) {
      truncated = true;
      break;
    }

    if (URL_HARD_STOP_CHARACTERS.has(character)) {
      truncated = true;
      break;
    }

    if (
      character === '&' &&
      !sawQuery &&
      (nextCharacter === '&' || nextCharacter === '>' || nextCharacter === '|')
    ) {
      truncated = true;
      break;
    }

    if (!URL_SAFE_CHARACTER_PATTERN.test(character)) {
      truncated = true;
      break;
    }

    if (character === '?') {
      sawQuery = true;
    }

    result += character;
  }

  if (!truncated) {
    return result;
  }

  return trimTruncatedUrlPath(result);
}

function sanitizeDetectedSuggestion(input: string, options?: { urlLike?: boolean }): string {
  const withoutControlSequences = stripTerminalControlSequences(input).trim();
  const shellTrimmed = options?.urlLike
    ? trimShellDelimitedUrlSuffix(withoutControlSequences)
    : withoutControlSequences;
  const withoutVisibleNoise = trimTrailingSuggestionNoise(withoutControlSequences);
  const withoutTerminalFragments = trimTrailingTerminalBracketFragments(
    options?.urlLike ? trimTrailingSuggestionNoise(shellTrimmed) : withoutVisibleNoise,
  );
  return trimTrailingSuggestionNoise(withoutTerminalFragments);
}

function collectUrlMatches(
  input: string,
  pattern: (typeof URL_PATTERNS)[number],
  seenPorts: Set<number>,
  results: PortDetectionMatch[],
): void {
  pattern.lastIndex = 0;

  let match = pattern.exec(input);
  while (match) {
    const matchedText = match[0];
    const hasExplicitProtocol = match.length > 3;
    const protocol = (hasExplicitProtocol ? match[1] : 'http') as 'http' | 'https';
    const host = normalizeDetectedHost(hasExplicitProtocol ? match[2] : match[1]);
    const portValue = Number.parseInt(
      hasExplicitProtocol ? (match[3] ?? '') : (match[2] ?? ''),
      10,
    );
    pushUniqueDetection(
      results,
      seenPorts,
      host,
      portValue,
      protocol,
      sanitizeDetectedSuggestion(matchedText, { urlLike: true }),
    );
    match = pattern.exec(input);
  }
}

function collectListeningMatches(
  input: string,
  listeningPattern: ListeningPattern,
  seenPorts: Set<number>,
  results: PortDetectionMatch[],
): void {
  const { pattern } = listeningPattern;
  pattern.lastIndex = 0;

  let match = pattern.exec(input);
  while (match) {
    const portValue = Number.parseInt(match[1] ?? '', 10);
    pushUniqueDetection(
      results,
      seenPorts,
      null,
      portValue,
      'http',
      listeningPattern.suggestion(portValue),
    );
    match = pattern.exec(input);
  }
}

export function detectObservedPortsFromOutput(input: string): PortDetectionMatch[] {
  if (!input) {
    return [];
  }

  const results: PortDetectionMatch[] = [];
  const seenPorts = new Set<number>();

  for (const pattern of URL_PATTERNS) {
    collectUrlMatches(input, pattern, seenPorts, results);
  }

  for (const pattern of LISTENING_PATTERNS) {
    collectListeningMatches(input, pattern, seenPorts, results);
  }

  return results;
}
