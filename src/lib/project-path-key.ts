export function normalizeProjectPathKey(projectPath: string): string {
  const pathWithForwardSlashes = projectPath.replace(/\\/g, '/');
  const pathWithoutTrailingSlashes = pathWithForwardSlashes.replace(/\/+$/u, '');
  const normalizedPath = pathWithoutTrailingSlashes || projectPath;
  if (/^[A-Za-z]:/u.test(normalizedPath)) {
    return normalizedPath.charAt(0).toLowerCase() + normalizedPath.slice(1);
  }

  return normalizedPath;
}
