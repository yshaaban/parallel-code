import { describe, expect, it, vi } from 'vitest';
import {
  hasExactOwnEnumerableKeys,
  hasKeyCountAndRequiredKeys,
  hasOnlyOwnEnumerableKeys,
  isNonNegativeSafeInteger,
} from './type-guards';

describe('safe non-negative integer guard', () => {
  it.each([0, -0, 1, Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
    expect(isNonNegativeSafeInteger(value)).toBe(true);
  });

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    -Infinity,
    '1',
    null,
    undefined,
    {},
    1n,
  ])('rejects %s without coercion', (value) => {
    expect(isNonNegativeSafeInteger(value)).toBe(false);
  });
});

describe('object key guard contracts', () => {
  it.each([
    { value: {}, keys: [], exactOwn: true, countAndRequired: true, onlyOwn: true },
    { value: { a: 1 }, keys: ['a'], exactOwn: true, countAndRequired: true, onlyOwn: true },
    { value: { a: 1 }, keys: ['a', 'b'], exactOwn: false, countAndRequired: false, onlyOwn: true },
    {
      value: { a: 1, b: 2 },
      keys: ['a'],
      exactOwn: false,
      countAndRequired: false,
      onlyOwn: false,
    },
    { value: { a: 1 }, keys: ['a', 'a'], exactOwn: true, countAndRequired: false, onlyOwn: true },
    {
      value: { a: 1, b: 2 },
      keys: ['a', 'a'],
      exactOwn: false,
      countAndRequired: true,
      onlyOwn: false,
    },
  ])(
    'preserves each key family for $value and $keys',
    ({ value, keys, exactOwn, countAndRequired, onlyOwn }) => {
      expect(hasExactOwnEnumerableKeys(value, keys)).toBe(exactOwn);
      expect(hasKeyCountAndRequiredKeys(value, keys)).toBe(countAndRequired);
      expect(hasOnlyOwnEnumerableKeys(value, keys)).toBe(onlyOwn);
    },
  );

  it('preserves inherited and non-enumerable required keys only in the count-and-in family', () => {
    const inherited: object = Object.assign(Object.create({ a: 1 }) as object, { b: 2 });
    const nonEnumerable = Object.defineProperty({ b: 2 }, 'a', { value: 1 });
    for (const value of [inherited, nonEnumerable]) {
      expect(hasKeyCountAndRequiredKeys(value, ['a'])).toBe(true);
      expect(hasExactOwnEnumerableKeys(value, ['a'])).toBe(false);
      expect(hasOnlyOwnEnumerableKeys(value, ['a'])).toBe(false);
      expect(hasExactOwnEnumerableKeys(value, ['b'])).toBe(true);
      expect(hasOnlyOwnEnumerableKeys(value, ['b'])).toBe(true);
    }
  });

  it('ignores symbol and non-enumerable extras, and accepts null-prototype records', () => {
    const value = Object.assign(Object.create(null) as object, { a: 1, [Symbol('extra')]: 2 });
    Object.defineProperty(value, 'hidden', { value: 3 });
    expect(hasExactOwnEnumerableKeys(value, ['a'])).toBe(true);
    expect(hasKeyCountAndRequiredKeys(value, ['a'])).toBe(true);
    expect(hasOnlyOwnEnumerableKeys(value, ['a'])).toBe(true);
  });

  it('retains each family’s enumeration count and short-circuit behavior', () => {
    const ownKeys = vi.fn(() => ['a']);
    const has = vi.fn(() => true);
    const value = new Proxy({ a: 1 }, { ownKeys, has });
    expect(hasExactOwnEnumerableKeys(value, ['a'])).toBe(true);
    expect(ownKeys).toHaveBeenCalledTimes(2);
    expect(has).not.toHaveBeenCalled();
    ownKeys.mockClear();
    expect(hasExactOwnEnumerableKeys(value, [])).toBe(false);
    expect(ownKeys).toHaveBeenCalledTimes(1);
    ownKeys.mockClear();
    expect(hasKeyCountAndRequiredKeys(value, ['a'])).toBe(true);
    expect(ownKeys).toHaveBeenCalledTimes(1);
    expect(has).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'a');
    ownKeys.mockClear();
    has.mockClear();
    expect(hasOnlyOwnEnumerableKeys(value, ['a'])).toBe(true);
    expect(ownKeys).toHaveBeenCalledTimes(1);
    expect(has).not.toHaveBeenCalled();
  });
});
