import { describe, expect, it } from 'vitest';
import {
  classifyDependencyExposure,
  getLockPackageName,
  normalizeAuditNodePath,
} from '../../scripts/lib/dependency-exposure.mjs';

function createLock() {
  return {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { server: '1.0.0' },
        devDependencies: {
          renderer: '1.0.0',
          tooling: '1.0.0',
        },
      },
      'node_modules/server': {
        version: '1.0.0',
        dependencies: {
          duplicate: '1.0.0',
          shared: '1.0.0',
        },
      },
      'node_modules/server/node_modules/duplicate': { version: '1.0.0' },
      'node_modules/renderer': {
        version: '1.0.0',
        dependencies: {
          duplicate: '2.0.0',
        },
        peerDependencies: {
          shared: '1.0.0',
        },
      },
      'node_modules/duplicate': { version: '2.0.0' },
      'node_modules/shared': { version: '1.0.0' },
      'node_modules/tooling': {
        version: '1.0.0',
        dependencies: { 'tool-only': '1.0.0' },
        optionalDependencies: { 'platform-optional': '1.0.0' },
      },
      'node_modules/tool-only': { version: '1.0.0' },
    },
  };
}

function getNode(result: ReturnType<typeof classifyDependencyExposure>, nodePath: string) {
  const node = result.nodesByPath.get(nodePath);
  if (!node) throw new Error(`Expected classified dependency node ${nodePath}`);
  return node;
}

describe('dependency exposure classification', () => {
  it('tracks hoisted and nested identities with every exposure membership', () => {
    const result = classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] });

    expect(getNode(result, 'node_modules/server/node_modules/duplicate')).toMatchObject({
      version: '1.0.0',
      primaryExposure: 'backend-runtime',
    });
    expect(getNode(result, 'node_modules/duplicate')).toMatchObject({
      version: '2.0.0',
      primaryExposure: 'renderer-shipped',
    });
    expect(getNode(result, 'node_modules/shared').memberships).toEqual([
      {
        lane: 'backend-runtime',
        dependencyPath: ['node_modules/server', 'node_modules/shared'],
      },
      {
        lane: 'renderer-shipped',
        dependencyPath: ['node_modules/renderer', 'node_modules/shared'],
      },
      {
        lane: 'tooling',
        dependencyPath: ['node_modules/renderer', 'node_modules/shared'],
      },
    ]);
    expect(getNode(result, 'node_modules/tool-only')).toMatchObject({
      primaryExposure: 'tooling',
    });
  });

  it('accepts npm aliases while retaining install and package identities', () => {
    const lock = createLock();
    lock.packages[''].devDependencies.alias = 'npm:actual-package@1.0.0';
    lock.packages['node_modules/alias'] = { name: 'actual-package', version: '1.0.0' };

    const node = getNode(
      classifyDependencyExposure(lock, { rendererRoots: ['renderer'] }),
      'node_modules/alias',
    );

    expect(node).toMatchObject({
      installName: 'alias',
      name: 'actual-package',
      primaryExposure: 'tooling',
    });
  });

  it('skips absent optional edges but rejects absent required edges', () => {
    expect(() =>
      classifyDependencyExposure(createLock(), { rendererRoots: ['renderer'] }),
    ).not.toThrow();

    const lock = createLock();
    lock.packages['node_modules/tooling'].dependencies = { missing: '1.0.0' };
    expect(() => classifyDependencyExposure(lock, { rendererRoots: ['renderer'] })).toThrow(
      'Dangling dependency edge: node_modules/tooling -> missing',
    );
  });

  it('skips absent optional roots and lets optional declarations override required ones', () => {
    const lock = createLock();
    lock.packages[''].dependencies['platform-root'] = '1.0.0';
    lock.packages[''].optionalDependencies = { 'platform-root': '1.0.0' };
    lock.packages['node_modules/tooling'].dependencies = {
      'platform-child': '1.0.0',
      'tool-only': '1.0.0',
    };
    lock.packages['node_modules/tooling'].optionalDependencies = {
      'platform-child': '1.0.0',
    };

    expect(() => classifyDependencyExposure(lock, { rendererRoots: ['renderer'] })).not.toThrow();
  });

  it('fails when a concrete lock node has no declared-root path', () => {
    const lock = createLock();
    lock.packages['node_modules/orphan'] = { version: '1.0.0' };

    expect(() => classifyDependencyExposure(lock, { rendererRoots: ['renderer'] })).toThrow(
      'Installed lock package is not reachable from a declared root: node_modules/orphan',
    );
  });

  it('requires the npm lockfile v3 graph shape owned by the classifier', () => {
    const lock = createLock();
    lock.lockfileVersion = 2;

    expect(() => classifyDependencyExposure(lock, { rendererRoots: ['renderer'] })).toThrow(
      'package-lock lockfileVersion must be 3, received 2',
    );
  });

  it('requires renderer roots to stay renderer-only devDependencies', () => {
    expect(() => classifyDependencyExposure(createLock(), { rendererRoots: ['missing'] })).toThrow(
      'Renderer dependency root is not a devDependency: missing',
    );

    const lock = createLock();
    lock.packages[''].dependencies.renderer = '1.0.0';
    expect(() => classifyDependencyExposure(lock, { rendererRoots: ['renderer'] })).toThrow(
      'Renderer dependency root is also a backend dependency: renderer',
    );
  });

  it('normalizes audit paths and parses scoped lock names', () => {
    expect(normalizeAuditNodePath('.\\node_modules\\pkg\\')).toBe('node_modules/pkg');
    expect(getLockPackageName('node_modules/parent/node_modules/@scope/child')).toBe(
      '@scope/child',
    );
  });
});
