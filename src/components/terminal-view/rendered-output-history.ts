export interface RenderedOutputHistoryBuffer {
  append: (chunk: Uint8Array) => void;
  getBytes: () => Uint8Array;
  replace: (history: Uint8Array) => void;
}

export function createRenderedOutputHistoryBuffer(maxBytes: number): RenderedOutputHistoryBuffer {
  let flattenedCache = new Uint8Array(0);
  let segments: Uint8Array[] = [];
  let totalBytes = 0;

  function resetToSingleSegment(segment: Uint8Array): void {
    flattenedCache = segment.slice();
    segments = segment.length === 0 ? [] : [segment];
    totalBytes = segment.length;
  }

  function invalidateCache(): void {
    flattenedCache = new Uint8Array(0);
  }

  function clearSegments(): void {
    flattenedCache = new Uint8Array(0);
    segments = [];
    totalBytes = 0;
  }

  function trimOverflow(): void {
    let overflowBytes = Math.max(0, totalBytes - maxBytes);

    while (overflowBytes > 0 && segments.length > 0) {
      const firstSegment = segments[0];
      if (!firstSegment) {
        segments.shift();
        continue;
      }

      if (firstSegment.length <= overflowBytes) {
        overflowBytes -= firstSegment.length;
        totalBytes -= firstSegment.length;
        segments.shift();
        continue;
      }

      segments[0] = firstSegment.slice(overflowBytes);
      totalBytes -= overflowBytes;
      overflowBytes = 0;
    }

    if (segments.length === 0) {
      clearSegments();
    }
  }

  function append(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }

    if (chunk.length >= maxBytes) {
      resetToSingleSegment(chunk.slice(chunk.length - maxBytes));
      return;
    }

    const chunkCopy = chunk.slice();
    invalidateCache();
    segments.push(chunkCopy);

    totalBytes += chunkCopy.length;
    trimOverflow();
  }

  function replace(history: Uint8Array): void {
    if (history.length === 0) {
      clearSegments();
      return;
    }

    if (history.length <= maxBytes) {
      resetToSingleSegment(history.slice());
      return;
    }

    resetToSingleSegment(history.slice(history.length - maxBytes));
  }

  function getBytes(): Uint8Array {
    if (segments.length === 0) {
      return flattenedCache;
    }

    const onlySegment = segments[0];
    if (segments.length === 1 && onlySegment) {
      if (flattenedCache.length === onlySegment.length && flattenedCache.length > 0) {
        return flattenedCache;
      }

      flattenedCache = onlySegment.slice();
      return flattenedCache;
    }

    if (flattenedCache.length === totalBytes) {
      return flattenedCache;
    }

    const flattened = new Uint8Array(totalBytes);
    let offset = 0;
    for (const segment of segments) {
      flattened.set(segment, offset);
      offset += segment.length;
    }
    flattenedCache = flattened;
    return flattened;
  }

  return {
    append,
    getBytes,
    replace,
  };
}
