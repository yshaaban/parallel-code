import path from 'node:path';

const PACKAGE_ARTIFACT_EXTENSIONS = new Set([
  '.appimage',
  '.deb',
  '.dmg',
  '.exe',
  '.msi',
  '.pkg',
  '.rpm',
  '.snap',
  '.zip',
]);

/** Shared D15 policy for distributable packages and canonical unpacked Electron payloads. */
export function classifyReleaseArtifactPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('release/')) return null;
  const segments = relativePath.split('/');
  if (
    segments.length === 2 &&
    PACKAGE_ARTIFACT_EXTENSIONS.has(path.extname(segments[1]).toLowerCase())
  ) {
    return 'package';
  }
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());
  if (
    segments.length >= 4 &&
    normalizedSegments.at(-1) === 'app.asar' &&
    normalizedSegments.at(-2) === 'resources'
  ) {
    return 'app-asar';
  }
  return null;
}

export function isReleasePackageArtifactName(fileName) {
  return classifyReleaseArtifactPath(`release/${fileName}`) === 'package';
}
