import { describe, expect, it } from 'vitest';
import { getServerPort } from './server-port.js';

describe('getServerPort', () => {
  it('defaults to the Parallel Code browser port when PORT is missing', () => {
    expect(getServerPort({})).toBe(43_117);
  });

  it('accepts port zero for ephemeral browser-lab startup', () => {
    expect(getServerPort({ PORT: '0' })).toBe(0);
  });

  it('accepts valid explicit TCP ports', () => {
    expect(getServerPort({ PORT: '43123' })).toBe(43123);
  });

  it.each(['-1', '65536', '3.14', 'abc'])(
    'falls back to the Parallel Code browser port for invalid port value %s',
    (value) => {
      expect(getServerPort({ PORT: value })).toBe(43_117);
    },
  );
});
