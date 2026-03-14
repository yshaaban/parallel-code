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

const URL_PATTERNS = [
  /\b(https?):\/\/(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|::1):(\d{2,5})(?:\/[^\s]*)?/gi,
  /\b(127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]|::1):(\d{2,5})(?:\/[^\s]*)?/gi,
] as const;

const LISTENING_PATTERNS = [
  /\blistening on(?:[^0-9]+port)?[^0-9]+(\d{2,5})\b/gi,
  /\bserver(?:[^0-9]+started)?[^0-9]+port[^0-9]+(\d{2,5})\b/gi,
  /\bLocal:\s+https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d{2,5})\b/gi,
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

function sanitizeDetectedSuggestion(input: string): string {
  const withoutControlSequences = stripTerminalControlSequences(input).trim();
  const withoutVisibleNoise = trimTrailingSuggestionNoise(withoutControlSequences);
  const withoutTerminalFragments = trimTrailingTerminalBracketFragments(withoutVisibleNoise);
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
      sanitizeDetectedSuggestion(matchedText),
    );
    match = pattern.exec(input);
  }
}

function collectListeningMatches(
  input: string,
  pattern: RegExp,
  seenPorts: Set<number>,
  results: PortDetectionMatch[],
): void {
  pattern.lastIndex = 0;

  let match = pattern.exec(input);
  while (match) {
    const matchedText = match[0];
    const portValue = Number.parseInt(match[1] ?? '', 10);
    const protocol = matchedText.toLowerCase().includes('https://') ? 'https' : 'http';
    pushUniqueDetection(
      results,
      seenPorts,
      null,
      portValue,
      protocol,
      sanitizeDetectedSuggestion(matchedText),
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
