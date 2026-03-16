export function deleteRecordEntry<Value>(record: Record<string, Value>, key: string): void {
  Reflect.deleteProperty(record, key);
}
