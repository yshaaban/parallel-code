/** Runtime type assertion helpers for IPC handler args. */

import { BadRequestError } from './errors.js';
import { isInteger, isTcpPortNumber } from '../../src/lib/type-guards.js';

type TypePredicate<T> = (val: unknown) => val is T;

/** Generic type assertion factory. */
function assertType<T>(
  val: unknown,
  label: string,
  predicate: TypePredicate<T>,
  typeName: string,
): asserts val is T {
  if (!predicate(val)) throw new BadRequestError(`${label} must be ${typeName}`);
}

export function assertString(val: unknown, label: string): asserts val is string {
  assertType(val, label, (v): v is string => typeof v === 'string', 'a string');
}

export function assertInt(val: unknown, label: string): asserts val is number {
  assertType(val, label, isInteger, 'an integer');
}

export function assertTcpPortNumber(val: unknown, label: string): asserts val is number {
  assertType(val, label, isTcpPortNumber, 'an integer between 1 and 65535');
}

export function assertBoolean(val: unknown, label: string): asserts val is boolean {
  assertType(val, label, (v): v is boolean => typeof v === 'boolean', 'a boolean');
}

export function assertStringArray(val: unknown, label: string): asserts val is string[] {
  assertType(
    val,
    label,
    (v): v is string[] => Array.isArray(v) && v.every((item) => typeof item === 'string'),
    'a string array',
  );
}

export function assertOptionalString(
  val: unknown,
  label: string,
): asserts val is string | undefined {
  assertType(
    val,
    label,
    (v): v is string | undefined => v === undefined || typeof v === 'string',
    'a string or undefined',
  );
}

export function assertOptionalBoolean(
  val: unknown,
  label: string,
): asserts val is boolean | undefined {
  assertType(
    val,
    label,
    (v): v is boolean | undefined => v === undefined || typeof v === 'boolean',
    'a boolean or undefined',
  );
}

export function assertOptionalInt(val: unknown, label: string): asserts val is number | undefined {
  assertType(
    val,
    label,
    (v): v is number | undefined => v === undefined || isInteger(v),
    'an integer or undefined',
  );
}
