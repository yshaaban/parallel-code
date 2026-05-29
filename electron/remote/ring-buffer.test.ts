import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ring-buffer.js';

describe('RingBuffer', () => {
  it('reads back written data', () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('hello'));
    expect(rb.read().toString()).toBe('hello');
    expect(rb.length).toBe(5);
  });

  it('concatenates multiple writes', () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('foo'));
    rb.write(Buffer.from('bar'));
    expect(rb.read().toString()).toBe('foobar');
    expect(rb.length).toBe(6);
  });

  it('wraps around when capacity is exceeded', () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from('ABCDEFGH')); // fills exactly
    expect(rb.read().toString()).toBe('ABCDEFGH');
    rb.write(Buffer.from('IJ')); // wraps: overwrites A,B
    expect(rb.read().toString()).toBe('CDEFGHIJ');
    expect(rb.length).toBe(8);
  });

  it('handles write larger than capacity', () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from('ABCDEFGH'));
    // Only last 4 bytes should be kept
    expect(rb.read().toString()).toBe('EFGH');
    expect(rb.length).toBe(4);
  });

  it('handles write exactly equal to capacity', () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from('ABCD'));
    expect(rb.read().toString()).toBe('ABCD');
    expect(rb.length).toBe(4);
  });

  it('handles multiple small writes that wrap multiple times', () => {
    const rb = new RingBuffer(4);
    // Fill: ABCD
    rb.write(Buffer.from('AB'));
    rb.write(Buffer.from('CD'));
    // Wrap: overwrites AB with EF → EFCD in buffer, reads as CDEF
    rb.write(Buffer.from('EF'));
    expect(rb.read().toString()).toBe('CDEF');
    // Wrap again: GH overwrites CD → EFGH in buffer, reads as EFGH
    rb.write(Buffer.from('GH'));
    expect(rb.read().toString()).toBe('EFGH');
  });

  it('toBase64 encodes correctly', () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('hello'));
    expect(rb.toBase64()).toBe(Buffer.from('hello').toString('base64'));
  });

  it('clear resets the buffer', () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from('data'));
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.read().toString()).toBe('');
  });

  it('returns a copy, not a reference to internal buffer', () => {
    const rb = new RingBuffer(16);
    rb.write(Buffer.from('test'));
    const copy = rb.read();
    copy[0] = 0;
    expect(rb.read().toString()).toBe('test');
  });

  it('handles write that spans the wrap boundary', () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from('ABCDEF')); // pos=6, 2 bytes left at end
    rb.write(Buffer.from('GHIJ')); // 2 at end + 2 at start → wraps
    expect(rb.read().toString()).toBe('CDEFGHIJ');
  });

  it('starts at a smaller allocation and grows on demand', () => {
    const changes: Array<{ capacity: number; previousCapacity: number; reason: string }> = [];
    const rb = new RingBuffer(64, {
      initialCapacity: 8,
      onCapacityChange: ({ capacity, previousCapacity, reason }) => {
        changes.push({ capacity, previousCapacity, reason });
      },
    });

    expect(rb.allocatedCapacity).toBe(8);
    rb.write(Buffer.from('ABCDEFGH'));
    expect(rb.allocatedCapacity).toBe(8);

    rb.write(Buffer.from('I'));
    expect(rb.allocatedCapacity).toBe(16);
    expect(rb.read().toString()).toBe('ABCDEFGHI');
    expect(changes).toEqual([
      { capacity: 8, previousCapacity: 0, reason: 'initial' },
      { capacity: 16, previousCapacity: 8, reason: 'grow' },
    ]);
  });

  it('grows only up to the maximum capacity and keeps the retained tail', () => {
    const rb = new RingBuffer(16, { initialCapacity: 4 });

    rb.write(Buffer.from('ABCDEFGH'));
    expect(rb.allocatedCapacity).toBe(8);
    rb.write(Buffer.from('IJKLMNOPQRST'));

    expect(rb.allocatedCapacity).toBe(16);
    expect(rb.length).toBe(16);
    expect(rb.read().toString()).toBe('EFGHIJKLMNOPQRST');
  });

  it('validates capacity arguments', () => {
    expect(() => new RingBuffer(0)).toThrow('capacity must be a positive safe integer');
    expect(() => new RingBuffer(64, { initialCapacity: 0 })).toThrow(
      'initialCapacity must be a positive safe integer',
    );
  });
});
