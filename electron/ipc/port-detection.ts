interface PortDetectionMatch {
  port: number;
  protocol: 'http' | 'https';
  suggestion: string;
}

const URL_PATTERNS = [
  /\bhttps?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d{2,5})(?:\/[^\s]*)?/gi,
  /\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d{2,5})(?:\/[^\s]*)?/gi,
];

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
  port: number,
  protocol: 'http' | 'https',
  suggestion: string,
): void {
  if (!isValidPort(port) || seenPorts.has(port)) {
    return;
  }

  seenPorts.add(port);
  results.push({
    port,
    protocol,
    suggestion,
  });
}

function inferProtocol(matchedText: string): 'http' | 'https' {
  return matchedText.toLowerCase().includes('https://') ? 'https' : 'http';
}

function collectMatches(
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
    pushUniqueDetection(
      results,
      seenPorts,
      portValue,
      inferProtocol(matchedText),
      matchedText.trim(),
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
    collectMatches(input, pattern, seenPorts, results);
  }

  for (const pattern of LISTENING_PATTERNS) {
    collectMatches(input, pattern, seenPorts, results);
  }

  return results;
}
