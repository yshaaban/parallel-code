import path from 'path';

export function getCompiledElectronAppRoot(compiledMainDir: string): string {
  return path.resolve(compiledMainDir, '..', '..');
}

export function getElectronPreloadPath(compiledMainDir: string): string {
  return path.join(getCompiledElectronAppRoot(compiledMainDir), 'electron', 'preload.cjs');
}

export function getDevelopmentIconPath(compiledMainDir: string): string {
  return path.join(getCompiledElectronAppRoot(compiledMainDir), 'build', 'icon.png');
}

export function getFrontendIndexPath(compiledMainDir: string): string {
  return path.join(getCompiledElectronAppRoot(compiledMainDir), 'dist', 'index.html');
}
