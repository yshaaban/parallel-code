import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLockPackageName } from '../../scripts/lib/dependency-exposure.mjs';

type LockPackage = {
  hasInstallScript?: boolean;
  version?: string;
};

const projectRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  allowScripts?: Record<string, boolean>;
  packageManager?: string;
};
const packageLock = JSON.parse(
  readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'),
) as { packages?: Record<string, LockPackage> };
const installWorkflowSources = ['ci.yml', 'release.yml'].map((fileName) =>
  readFileSync(path.join(projectRoot, '.github', 'workflows', fileName), 'utf8'),
);

function readPinnedNpmVersion(value: string | undefined): [number, number, number] {
  const match = /^npm@(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? '');
  if (!match) {
    throw new Error('packageManager must pin an exact npm version');
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('dependency install-script policy', () => {
  it('keeps the Docker install on the pinned runtime and lifecycle policy', () => {
    const dockerfile = readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
    const nodeVersion = readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8')
      .trim()
      .replace(/^v/u, '');
    const npmVersion = packageJson.packageManager?.replace(/^npm@/u, '');
    expect(dockerfile).toContain(`FROM node:${nodeVersion}-trixie AS dev`);
    expect(dockerfile).toContain(`npm install -g npm@${npmVersion} `);
    const policyCopy = dockerfile.indexOf('package.json package-lock.json .npmrc ./');
    expect(policyCopy).toBeGreaterThan(-1);
    expect(policyCopy).toBeLessThan(dockerfile.indexOf('npm ci'));
    const nativeFixupsCopy = dockerfile.indexOf(
      'scripts/postinstall-native-fixups.mjs ./scripts/postinstall-native-fixups.mjs',
    );
    expect(nativeFixupsCopy).toBeGreaterThan(-1);
    expect(nativeFixupsCopy).toBeLessThan(dockerfile.indexOf('npm ci'));
    expect(dockerfile).not.toMatch(/(?:dangerously-allow-all-scripts|ignore-scripts)/iu);
    const ignored = readFileSync(path.join(projectRoot, '.dockerignore'), 'utf8').split('\n');
    expect(ignored).toEqual(expect.arrayContaining(['.env', '.env.*', 'tmp']));
  });

  it('pins and approves exactly every executable dependency lifecycle in the lock', () => {
    const executableLockIdentities = [
      ...new Set(
        Object.entries(packageLock.packages ?? {})
          .filter(
            ([packagePath, metadata]) =>
              packagePath.includes('node_modules/') && metadata.hasInstallScript === true,
          )
          .map(([packagePath, metadata]) => {
            if (!metadata.version) {
              throw new Error(`Install-script lock node is missing a version: ${packagePath}`);
            }
            return `${getLockPackageName(packagePath)}@${metadata.version}`;
          }),
      ),
    ].sort();
    const approvals = Object.entries(packageJson.allowScripts ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    expect(approvals.every(([, approved]) => approved === true)).toBe(true);
    expect(approvals.map(([identity]) => identity)).toEqual(executableLockIdentities);
  });

  it('pins npm and fails closed instead of bypassing lifecycle review', () => {
    const npmConfig = readFileSync(path.join(projectRoot, '.npmrc'), 'utf8');
    const [npmMajor, npmMinor] = readPinnedNpmVersion(packageJson.packageManager);

    expect(npmMajor > 11 || (npmMajor === 11 && npmMinor >= 17)).toBe(true);
    expect(npmConfig).toMatch(/^strict-allow-scripts=true$/mu);
    expect(npmConfig).not.toMatch(/(?:dangerously-allow-all-scripts|ignore-scripts)\s*=\s*true/iu);
  });

  it('installs with the pinned policy in CI and release without lifecycle bypasses', () => {
    for (const workflowSource of installWorkflowSources) {
      const installCommandLines = workflowSource
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('npm ci'));
      const pinStepOffsets = [...workflowSource.matchAll(/- name: Use lockfile npm/gu)].map(
        (match) => match.index ?? -1,
      );
      const installStepOffsets = [...workflowSource.matchAll(/- run: npm ci/gu)].map(
        (match) => match.index ?? -1,
      );

      expect(installCommandLines.length).toBeGreaterThan(0);
      expect(new Set(installCommandLines)).toEqual(new Set(['- run: npm ci']));
      expect(pinStepOffsets).toHaveLength(installStepOffsets.length);
      for (const [index, installOffset] of installStepOffsets.entries()) {
        const pinOffset = pinStepOffsets[index];
        expect(pinOffset).toBeLessThan(installOffset);
        if (index > 0) {
          expect(pinOffset).toBeGreaterThan(installStepOffsets[index - 1] ?? -1);
        }
      }
      expect(workflowSource).toMatch(/required_npm=.*packageManager\.replace/u);
      expect(workflowSource).not.toMatch(/(?:dangerously-allow-all-scripts|ignore-scripts)/iu);
    }
  });
});
