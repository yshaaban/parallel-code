const TICK_MS = 16;

export function parseIntegerFlag(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createRepeatedPayload(token, width) {
  const minimumWidth = Math.max(1, width);
  const repeatCount = Math.max(1, Math.ceil(minimumWidth / token.length));
  return token.repeat(repeatCount).slice(0, minimumWidth);
}

export async function writeFrames(lines, delayMs = TICK_MS) {
  for (const line of lines) {
    process.stdout.write(`${line}\r\n`);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

export function writeStatusLine(text) {
  process.stdout.write(`\r\x1b[2K${text}`);
}

export function writeSection(title) {
  process.stdout.write(`\r\n=== ${title} ===\r\n`);
}
