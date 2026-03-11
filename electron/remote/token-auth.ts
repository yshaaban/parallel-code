import { Buffer } from 'buffer';
import { timingSafeEqual } from 'crypto';

export interface TokenComparator {
  safeCompare: (candidate: string | null | undefined) => boolean;
}

export function createTokenComparator(token: string): TokenComparator {
  const tokenBuffer = Buffer.from(token);

  function safeCompare(candidate: string | null | undefined): boolean {
    if (!candidate) return false;

    const candidateBuffer = Buffer.from(candidate);
    if (candidateBuffer.length !== tokenBuffer.length) return false;
    return timingSafeEqual(candidateBuffer, tokenBuffer);
  }

  return { safeCompare };
}
