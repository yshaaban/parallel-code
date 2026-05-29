import { describe, expect, it } from 'vitest';
import { normalizeProjectPathKey } from './project-path-key';

describe('normalizeProjectPathKey', () => {
  it('normalizes separators, trailing slashes, and Windows drive letter casing', () => {
    expect(normalizeProjectPathKey('C:\\Users\\me\\src\\app\\')).toBe('c:/Users/me/src/app');
    expect(normalizeProjectPathKey('c:/Users/me/src/app')).toBe('c:/Users/me/src/app');
    expect(normalizeProjectPathKey('/Users/me/src/app/')).toBe('/Users/me/src/app');
  });
});
