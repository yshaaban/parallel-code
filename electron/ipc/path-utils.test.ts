import { describe, expect, it } from 'vitest';

import { BadRequestError } from './errors.js';
import { validateBranchName, validateOptionalBranchName } from './path-utils.js';

describe('validateBranchName', () => {
  it('accepts branch names accepted by git check-ref-format --branch', () => {
    expect(() => validateBranchName('main', 'branchName')).not.toThrow();
    expect(() => validateBranchName('feature/task-1', 'branchName')).not.toThrow();
    expect(() => validateBranchName('refs/heads/release/main', 'branchName')).not.toThrow();
  });

  it('rejects malformed branch names as bad request input', () => {
    const invalidNames = [
      '',
      '-feature',
      'HEAD',
      'feature..bad',
      'feature task',
      'feature.lock',
      'feature/',
      '.feature',
      'feature@{bad}',
      'feature//bad',
    ];

    for (const branchName of invalidNames) {
      expect(() => validateBranchName(branchName, 'branchName')).toThrow(BadRequestError);
    }
  });

  it('accepts undefined optional branch names and validates provided values', () => {
    expect(() => validateOptionalBranchName(undefined, 'baseBranch')).not.toThrow();
    expect(() => validateOptionalBranchName('release/main', 'baseBranch')).not.toThrow();
    expect(() => validateOptionalBranchName('feature..bad', 'baseBranch')).toThrow(BadRequestError);
  });
});
