export function deleteRecordEntry<Value>(record: Record<string, Value>, key: string): void {
  Reflect.deleteProperty(record, key);
}

export function omitRecordKey<Value>(
  record: Record<string, Value>,
  key: string,
): Record<string, Value> {
  const { [key]: _omitted, ...nextRecord } = record;
  return nextRecord;
}
