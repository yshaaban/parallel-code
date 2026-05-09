export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

export function isTcpPortNumber(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

export function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

export function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

export function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

export function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

export function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value);
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isArrayOf<TValue>(
  value: unknown,
  guard: (entry: unknown) => entry is TValue,
): value is TValue[] {
  return Array.isArray(value) && value.every(guard);
}

function isStringValue(value: unknown): value is string {
  return typeof value === 'string';
}

export function isStringArray(value: unknown): value is string[] {
  return isArrayOf(value, isStringValue);
}

export function hasOwnKey<TObject extends object>(
  object: TObject,
  key: PropertyKey,
): key is keyof TObject {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function isStringKeyOf<TObject extends object>(
  value: unknown,
  object: TObject,
): value is Extract<keyof TObject, string> {
  return typeof value === 'string' && hasOwnKey(object, value);
}

export function isStringMember<T extends string>(
  value: unknown,
  members: Readonly<Record<T, true>>,
): value is T {
  return isStringKeyOf(value, members);
}

export function isStringTupleMember<const TValues extends readonly string[]>(
  value: unknown,
  members: TValues,
): value is TValues[number] {
  return typeof value === 'string' && members.includes(value);
}
