const BINARY_SNIFF_BYTES = 8 * 1024;

export function isBinaryNumstat(output: string): boolean {
  return output.split('\n').some((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }

    const [added, removed] = trimmed.split('\t');
    return added === '-' && removed === '-';
  });
}

export function looksBinaryBuffer(buffer: Buffer, sampleBytes = BINARY_SNIFF_BYTES): boolean {
  const limit = Math.min(buffer.length, sampleBytes);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}
