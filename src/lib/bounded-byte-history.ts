export interface BoundedByteHistory {
  append: (chunk: Uint8Array) => void;
  getBytes: () => Uint8Array;
  getTailBytes: (maxBytes: number) => Uint8Array;
  replace: (history: Uint8Array) => void;
}

interface ByteBlock {
  bytes: Uint8Array;
  end: number;
  start: number;
}

const DEFAULT_BLOCK_BYTES = 16 * 1024;

/**
 * Capped byte history optimized for frequent appends and infrequent reads.
 * Fixed-size writable blocks isolate caller buffers, keep segment metadata
 * bounded, and let front trimming advance offsets without copying retained
 * history. The full retained window is flattened only when a reader asks for it.
 */
export function createBoundedByteHistory(maxBytes: number): BoundedByteHistory {
  const byteLimit = Number.isFinite(maxBytes)
    ? Math.max(0, Math.floor(maxBytes))
    : maxBytes === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : 0;
  const blockCapacity = Number.isFinite(byteLimit)
    ? Math.max(1, Math.min(DEFAULT_BLOCK_BYTES, byteLimit))
    : DEFAULT_BLOCK_BYTES;

  let blocks: ByteBlock[] = [];
  let firstBlockIndex = 0;
  let flattenedCache: Uint8Array = new Uint8Array(0);
  let totalBytes = 0;

  function invalidateCache(): void {
    flattenedCache = new Uint8Array(0);
  }

  function clear(): void {
    blocks = [];
    firstBlockIndex = 0;
    flattenedCache = new Uint8Array(0);
    totalBytes = 0;
  }

  function appendCopiedBytes(bytes: Uint8Array): void {
    let readOffset = 0;
    while (readOffset < bytes.length) {
      let tail = blocks[blocks.length - 1];
      if (!tail || tail.end === tail.bytes.length) {
        tail = {
          bytes: new Uint8Array(blockCapacity),
          end: 0,
          start: 0,
        };
        blocks.push(tail);
      }

      const writableBytes = Math.min(tail.bytes.length - tail.end, bytes.length - readOffset);
      tail.bytes.set(bytes.subarray(readOffset, readOffset + writableBytes), tail.end);
      tail.end += writableBytes;
      readOffset += writableBytes;
      totalBytes += writableBytes;
    }
  }

  function compactBlockArrayIfNeeded(): void {
    const activeBlockCount = blocks.length - firstBlockIndex;
    if (activeBlockCount === 0) {
      blocks = [];
      firstBlockIndex = 0;
      return;
    }

    if (firstBlockIndex >= activeBlockCount) {
      blocks = blocks.slice(firstBlockIndex);
      firstBlockIndex = 0;
    }
  }

  function trimOverflow(): void {
    let overflowBytes = Math.max(0, totalBytes - byteLimit);
    while (overflowBytes > 0 && firstBlockIndex < blocks.length) {
      const firstBlock = blocks[firstBlockIndex];
      if (!firstBlock) {
        firstBlockIndex += 1;
        continue;
      }

      const activeBlockBytes = firstBlock.end - firstBlock.start;
      if (activeBlockBytes <= overflowBytes) {
        overflowBytes -= activeBlockBytes;
        totalBytes -= activeBlockBytes;
        firstBlockIndex += 1;
        continue;
      }

      firstBlock.start += overflowBytes;
      totalBytes -= overflowBytes;
      overflowBytes = 0;
    }

    compactBlockArrayIfNeeded();
  }

  function replace(history: Uint8Array): void {
    clear();
    if (byteLimit === 0 || history.length === 0) {
      return;
    }

    const retainedBytes = Number.isFinite(byteLimit)
      ? history.subarray(Math.max(0, history.length - byteLimit))
      : history;
    appendCopiedBytes(retainedBytes);
  }

  function append(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }

    if (byteLimit === 0 || chunk.length >= byteLimit) {
      replace(chunk);
      return;
    }

    invalidateCache();
    appendCopiedBytes(chunk);
    trimOverflow();
  }

  function copyActiveBytes(): Uint8Array {
    const flattened = new Uint8Array(totalBytes);
    let writeOffset = 0;

    for (let index = firstBlockIndex; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (!block) {
        continue;
      }

      const activeBytes = block.bytes.subarray(block.start, block.end);
      flattened.set(activeBytes, writeOffset);
      writeOffset += activeBytes.length;
    }

    return flattened;
  }

  function getBytes(): Uint8Array {
    if (flattenedCache.length !== totalBytes) {
      flattenedCache = copyActiveBytes();
    }

    return flattenedCache;
  }

  function getTailBytes(maxTailBytes: number): Uint8Array {
    const tailBytes = Math.min(Math.max(0, Math.floor(maxTailBytes)), totalBytes);
    if (tailBytes === 0) {
      return new Uint8Array(0);
    }

    const lastBlock = blocks[blocks.length - 1];
    if (
      blocks.length - firstBlockIndex === 1 &&
      lastBlock &&
      tailBytes <= lastBlock.end - lastBlock.start
    ) {
      return lastBlock.bytes.subarray(lastBlock.end - tailBytes, lastBlock.end);
    }

    const tail = new Uint8Array(tailBytes);
    let remainingBytes = tailBytes;
    let writeOffset = tailBytes;

    for (
      let index = blocks.length - 1;
      index >= firstBlockIndex && remainingBytes > 0;
      index -= 1
    ) {
      const block = blocks[index];
      if (!block) {
        continue;
      }

      const activeBlockBytes = block.end - block.start;
      const bytesFromBlock = Math.min(activeBlockBytes, remainingBytes);
      writeOffset -= bytesFromBlock;
      tail.set(block.bytes.subarray(block.end - bytesFromBlock, block.end), writeOffset);
      remainingBytes -= bytesFromBlock;
    }

    return tail;
  }

  return {
    append,
    getBytes,
    getTailBytes,
    replace,
  };
}
