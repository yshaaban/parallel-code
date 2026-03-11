/** Runtime type assertion helpers for IPC handler args. */

import { BadRequestError } from './errors.js';

export function assertString(val: unknown, label: string): asserts val is string {
  if (typeof val !== 'string') throw new BadRequestError(`${label} must be a string`);
}

export function assertInt(val: unknown, label: string): asserts val is number {
  if (typeof val !== 'number' || !Number.isInteger(val))
    throw new BadRequestError(`${label} must be an integer`);
}

export function assertBoolean(val: unknown, label: string): asserts val is boolean {
  if (typeof val !== 'boolean') throw new BadRequestError(`${label} must be a boolean`);
}

export function assertStringArray(val: unknown, label: string): asserts val is string[] {
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string'))
    throw new BadRequestError(`${label} must be a string array`);
}

export function assertOptionalString(
  val: unknown,
  label: string,
): asserts val is string | undefined {
  if (val !== undefined && typeof val !== 'string')
    throw new BadRequestError(`${label} must be a string or undefined`);
}

export function assertOptionalBoolean(
  val: unknown,
  label: string,
): asserts val is boolean | undefined {
  if (val !== undefined && typeof val !== 'boolean')
    throw new BadRequestError(`${label} must be a boolean or undefined`);
}
