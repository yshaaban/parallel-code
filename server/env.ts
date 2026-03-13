import { existsSync, readFileSync } from 'fs';

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const firstChar = value[0];
  const lastChar = value[value.length - 1];
  if ((firstChar === '"' && lastChar === '"') || (firstChar === "'" && lastChar === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function parseEnvLine(line: string): [key: string, value: string] | null {
  const trimmedLine = line.trim();
  if (!trimmedLine || trimmedLine.startsWith('#')) {
    return null;
  }

  const separatorIndex = trimmedLine.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmedLine.slice(0, separatorIndex).trim();
  if (!key) {
    return null;
  }

  const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
  return [key, stripWrappingQuotes(rawValue)];
}

export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/u)) {
    const parsedLine = parseEnvLine(line);
    if (!parsedLine) {
      continue;
    }

    const [key, value] = parsedLine;
    parsed[key] = value;
  }

  return parsed;
}

function setMissingEnvValues(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  setMissingEnvValues(parseEnvFile(readFileSync(path, 'utf8')));
}
