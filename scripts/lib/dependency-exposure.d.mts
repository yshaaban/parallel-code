export type DependencyExposureLane = 'backend-runtime' | 'renderer-shipped' | 'tooling';

export interface DependencyExposureMembership {
  lane: DependencyExposureLane;
  dependencyPath: readonly string[];
}

export interface DependencyExposureNode {
  nodePath: string;
  installName: string;
  name: string;
  version: string;
  primaryExposure: DependencyExposureLane;
  memberships: readonly DependencyExposureMembership[];
}

export interface DependencyExposure {
  nodes: readonly DependencyExposureNode[];
  nodesByPath: Map<string, DependencyExposureNode>;
}

export const RENDERER_BUNDLED_DEPENDENCY_NAMES: readonly string[];
export const DEPENDENCY_EXPOSURE_LANES: readonly DependencyExposureLane[];

export function getLockPackageName(packagePath: string): string;
export function normalizeAuditNodePath(nodePath: string): string;
export function classifyDependencyExposure(
  packageLock: unknown,
  options?: { rendererRoots?: readonly string[] },
): DependencyExposure;
