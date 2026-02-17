/** Check if diff output indicates a binary file. */
export function isBinaryDiff(raw: string): boolean {
  return raw.includes("Binary files") && raw.includes("differ");
}
