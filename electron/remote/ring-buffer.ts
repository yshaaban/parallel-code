const DEFAULT_MAX_CAPACITY_BYTES = 2 * 1024 * 1024;
const DEFAULT_INITIAL_CAPACITY_BYTES = 128 * 1024;

export interface RingBufferCapacityChange {
  capacity: number;
  maxCapacity: number;
  previousCapacity: number;
  reason: 'grow' | 'initial';
}

export interface RingBufferOptions {
  initialCapacity?: number;
  onCapacityChange?: (change: RingBufferCapacityChange) => void;
}

function normalizeCapacity(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function getNextCapacity(
  currentCapacity: number,
  requiredCapacity: number,
  maxCapacity: number,
): number {
  let nextCapacity = currentCapacity;
  while (nextCapacity < requiredCapacity && nextCapacity < maxCapacity) {
    nextCapacity = Math.min(maxCapacity, nextCapacity * 2);
  }

  return nextCapacity;
}

/** Elastic capped ring buffer for terminal scrollback replay. */
export class RingBuffer {
  private buf: Buffer;
  private pos = 0;
  private full = false;
  private readonly maxCapacity: number;
  private readonly onCapacityChange: ((change: RingBufferCapacityChange) => void) | undefined;

  constructor(capacity: number = DEFAULT_MAX_CAPACITY_BYTES, options: RingBufferOptions = {}) {
    this.maxCapacity = normalizeCapacity(capacity, 'capacity');
    this.onCapacityChange = options.onCapacityChange;
    const requestedInitialCapacity =
      options.initialCapacity ?? Math.min(DEFAULT_INITIAL_CAPACITY_BYTES, this.maxCapacity);
    const initialCapacity = Math.min(
      this.maxCapacity,
      normalizeCapacity(requestedInitialCapacity, 'initialCapacity'),
    );
    this.buf = Buffer.alloc(initialCapacity);
    this.onCapacityChange?.({
      capacity: initialCapacity,
      maxCapacity: this.maxCapacity,
      previousCapacity: 0,
      reason: 'initial',
    });
  }

  private get capacity(): number {
    return this.buf.length;
  }

  private growFor(requiredCapacity: number): void {
    if (requiredCapacity <= this.capacity || this.capacity >= this.maxCapacity) {
      return;
    }

    const previousCapacity = this.capacity;
    const currentData = this.read();
    const nextCapacity = getNextCapacity(previousCapacity, requiredCapacity, this.maxCapacity);
    this.buf = Buffer.alloc(nextCapacity);
    currentData.copy(this.buf, 0);
    this.pos = currentData.length % nextCapacity;
    this.full = currentData.length === nextCapacity;
    this.onCapacityChange?.({
      capacity: nextCapacity,
      maxCapacity: this.maxCapacity,
      previousCapacity,
      reason: 'grow',
    });
  }

  /** Append data to the ring buffer. */
  write(data: Buffer): void {
    if (data.length === 0) {
      return;
    }

    if (data.length >= this.maxCapacity) {
      this.growFor(this.maxCapacity);
      // Data larger than buffer — keep only the tail
      data.copy(this.buf, 0, data.length - this.maxCapacity);
      this.pos = 0;
      this.full = true;
      return;
    }

    this.growFor(Math.min(this.maxCapacity, this.length + data.length));

    const spaceAtEnd = this.capacity - this.pos;
    if (data.length <= spaceAtEnd) {
      data.copy(this.buf, this.pos);
    } else {
      data.copy(this.buf, this.pos, 0, spaceAtEnd);
      data.copy(this.buf, 0, spaceAtEnd);
    }

    this.pos = (this.pos + data.length) % this.capacity;
    if (!this.full && this.pos < data.length) {
      this.full = true;
    }
  }

  /** Read all buffered data in chronological order (returns a copy). */
  read(): Buffer {
    if (!this.full) {
      return Buffer.from(this.buf.subarray(0, this.pos));
    }

    return Buffer.concat([this.buf.subarray(this.pos), this.buf.subarray(0, this.pos)]);
  }

  /** Return buffered data as a base64 string. */
  toBase64(): string {
    return this.read().toString('base64');
  }

  /** Number of bytes currently stored. */
  get length(): number {
    return this.full ? this.capacity : this.pos;
  }

  /** Number of bytes currently allocated by the elastic backing store. */
  get allocatedCapacity(): number {
    return this.capacity;
  }

  /** Maximum retained bytes for this ring buffer. */
  get maximumCapacity(): number {
    return this.maxCapacity;
  }

  /** Reset the buffer. */
  clear(): void {
    this.pos = 0;
    this.full = false;
  }
}
