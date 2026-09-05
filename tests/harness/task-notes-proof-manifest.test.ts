import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTaskNotesProofReport,
  buildSourceSnapshot,
  canonicalJson,
  getTaskNotesProofReportIdentity,
  runTaskNotesProofManifest,
  validateCommandEvidence,
  verifyTaskNotesProofReport,
} from '../../scripts/task-notes-proof-manifest.mjs';

let root = '';

function write(relativePath: string, contents: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function createFixtureRepository(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-task-notes-proof-'));
  git('init', '--quiet');
  git('config', 'user.email', 'proof@example.test');
  git('config', 'user.name', 'Proof Fixture');
  write(
    'package.json',
    JSON.stringify({ name: 'proof-fixture', packageManager: 'npm@11.17.0', type: 'module' }),
  );
  write('src/entry.ts', "import { value } from './dep.js';\nexport { value };\n");
  write('src/dep.ts', 'export const value = 1;\n');
  write('proof.config.json', '{"enabled":true}\n');
  write(
    'scripts/task-notes-proof-seed.json',
    JSON.stringify({
      artifactRoots: ['dist', 'dist-electron', 'dist-remote', 'dist-server'],
      commands: ['npm test'],
      entrypoints: ['src/entry.ts'],
      formatVersion: 1,
      includeFiles: ['package.json', 'proof.config.json'],
      includePathPatterns: ['^src/entry\\.ts$'],
      includePrefixes: [],
    }),
  );
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture');
}

afterEach(() => {
  if (root) fs.rmSync(root, { force: true, recursive: true });
  root = '';
});

describe('task notes proof manifest', () => {
  it('pins both production roots, every shipped artifact class, and Notes recovery surfaces', () => {
    const seed = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'scripts/task-notes-proof-seed.json'), 'utf8'),
    ) as {
      artifactRoots: string[];
      commands: string[];
      entrypoints: string[];
      includeFiles: string[];
    };

    expect(seed.entrypoints).toEqual(
      expect.arrayContaining(['electron/main.ts', 'server/main.ts']),
    );
    expect(seed.artifactRoots).toEqual(['dist', 'dist-electron', 'dist-remote', 'dist-server']);
    expect(seed.includeFiles).toEqual(
      expect.arrayContaining([
        '.prettierignore',
        '.prettierrc',
        'electron/preload.cjs',
        'eslint.config.js',
        'index.html',
        'scripts/build-electron.mjs',
        'scripts/build-release.mjs',
        'scripts/postinstall-native-fixups.mjs',
        'scripts/run-playwright-with-browser-artifacts.mjs',
        'scripts/run-vitest-scoped.mjs',
        'server/build-server.mjs',
        'src/App.tsx',
        'src/app/project-workflows.ts',
        'src/app/task-lifecycle-workflows.ts',
        'src/components/CloseTaskDialog.tsx',
        'src/components/TilingLayout.tsx',
        'src/components/app-shell/DesktopTaskNotesRecovery.tsx',
        'src/remote/App.tsx',
        'src/remote/index.html',
        'tests/harness/task-notes-proof-manifest.test.ts',
        'vitest.node.setup.ts',
        'vitest.setup.ts',
      ]),
    );
    expect(seed.commands.slice(-2)).toEqual([
      'npm run build -- --publish never',
      'npm run verify:electron-package',
    ]);
    expect(seed.commands.indexOf('npm test')).toBeLessThan(
      seed.commands.indexOf('npm run build -- --publish never'),
    );
  });

  it('hashes the candidate dependency closure and fails closed on a relevant dirty file', () => {
    createFixtureRepository();

    const snapshot = buildSourceSnapshot({ candidate: 'HEAD', projectRoot: root });
    expect(snapshot.digests).toEqual(
      expect.objectContaining({
        commandManifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        dependencyEdgeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        fixtureSeedDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        relevantTreeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        sourceManifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        toolchainDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    expect(snapshot.source.files.map((file) => file.path)).toEqual([
      'package.json',
      'proof.config.json',
      'scripts/task-notes-proof-seed.json',
      'src/dep.ts',
      'src/entry.ts',
    ]);
    expect(snapshot.source.dependencyEdges).toContainEqual({
      from: 'src/entry.ts',
      specifier: './dep.js',
      to: 'src/dep.ts',
    });

    write('src/dep.ts', 'export const value = 2;\n');
    expect(() => buildSourceSnapshot({ candidate: 'HEAD', projectRoot: root })).toThrow(
      /Relevant task-notes proof inputs are dirty or untracked/u,
    );
  });

  it('fails closed on a nonliteral dynamic dependency', () => {
    createFixtureRepository();
    write('src/entry.ts', "const target = './dep.js';\nvoid import(target);\n");
    git('add', 'src/entry.ts');
    git('commit', '--quiet', '-m', 'dynamic import');

    expect(() => buildSourceSnapshot({ candidate: 'HEAD', projectRoot: root })).toThrow(
      /Nonliteral dynamic import/u,
    );
  });

  it('requires exact ordered, successful command evidence and canonicalizes object keys', () => {
    expect(
      validateCommandEvidence(
        {
          commands: [
            { command: 'one', exitCode: 0 },
            { command: 'two', exitCode: 0 },
          ],
        },
        ['one', 'two'],
      ),
    ).toEqual([
      { command: 'one', exitCode: 0 },
      { command: 'two', exitCode: 0 },
    ]);
    expect(() =>
      validateCommandEvidence({ commands: [{ command: 'two', exitCode: 0 }] }, ['one']),
    ).toThrow(/failed at command 1/u);
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it('binds successful command evidence and the exact built artifact bytes', async () => {
    createFixtureRepository();
    const artifactRoots = ['dist', 'dist-electron', 'dist-remote', 'dist-server'];
    for (const artifactRoot of artifactRoots) {
      write(`${artifactRoot}/app.js`, `export const artifact = '${artifactRoot}';\n`);
    }
    write('release/parallel-code.dmg', 'promoted artifact bytes\n');
    const snapshot = buildSourceSnapshot({ candidate: 'HEAD', projectRoot: root });
    const evidence = validateCommandEvidence(
      { commands: [{ command: 'npm test', exitCode: 0 }] },
      snapshot.seed.commands,
    );
    const report = await buildTaskNotesProofReport({
      evidence,
      projectRoot: root,
      promotionArtifactPaths: ['release/parallel-code.dmg'],
      snapshot,
      writerTrain: 'remote',
    });

    expect(report.digests.artifactDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(getTaskNotesProofReportIdentity(report)).toEqual({
      artifactDigest: report.digests.artifactDigest,
      commandManifestDigest: report.digests.commandManifestDigest,
      dependencyEdgeDigest: report.digests.dependencyEdgeDigest,
      fixtureSeedDigest: report.digests.fixtureSeedDigest,
      formatVersion: 1,
      proofDigest: report.proofDigest,
      relevantTreeDigest: report.digests.relevantTreeDigest,
      sourceManifestDigest: report.digests.sourceManifestDigest,
      toolchainDigest: report.digests.toolchainDigest,
      writerTrain: 'remote',
    });
    await expect(verifyTaskNotesProofReport(root, snapshot, report)).resolves.toEqual(report);

    for (const artifactRoot of artifactRoots) {
      write(`${artifactRoot}/app.js`, `export const artifact = '${artifactRoot}-changed';\n`);
      await expect(verifyTaskNotesProofReport(root, snapshot, report)).rejects.toThrow(
        /stale for current source, toolchain, or artifacts/u,
      );
      write(`${artifactRoot}/app.js`, `export const artifact = '${artifactRoot}';\n`);
    }

    write('release/parallel-code.dmg', 'changed promoted artifact bytes\n');
    await expect(verifyTaskNotesProofReport(root, snapshot, report)).rejects.toThrow(
      /stale for current source, toolchain, or artifacts/u,
    );
  });

  it('composes the complete snapshot, writer-report, and verification CLI lifecycle', async () => {
    createFixtureRepository();
    for (const artifactRoot of ['dist', 'dist-electron', 'dist-remote', 'dist-server']) {
      write(`${artifactRoot}/app.js`, `export const artifact = '${artifactRoot}';\n`);
    }
    write('release/parallel-code.dmg', 'promoted artifact bytes\n');
    const preSnapshotPath = path.join(root, 'proof-pre.json');
    const evidencePath = path.join(root, 'proof-evidence.json');
    const reportPath = path.join(root, 'proof-report.json');

    await expect(
      runTaskNotesProofManifest(root, ['--candidate', 'HEAD', '--write-snapshot', preSnapshotPath]),
    ).resolves.toMatch(/^task-notes-proof source=[0-9a-f]{64}$/u);
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({ commands: [{ command: 'npm test', exitCode: 0 }] }),
      'utf8',
    );

    await expect(
      runTaskNotesProofManifest(root, [
        '--candidate',
        'HEAD',
        '--write-report',
        reportPath,
        '--pre-snapshot',
        preSnapshotPath,
        '--command-evidence',
        evidencePath,
        '--writer-train',
        'remote',
        '--promotion-artifact',
        'release/parallel-code.dmg',
      ]),
    ).resolves.toMatch(/^task-notes-proof source=[0-9a-f]{64} proof=[0-9a-f]{64}$/u);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      promotionArtifacts: Array<{ path: string }>;
      writerTrain: string;
    };
    expect(report.writerTrain).toBe('remote');
    expect(report.promotionArtifacts.map((artifact) => artifact.path)).toEqual([
      'release/parallel-code.dmg',
    ]);

    await expect(
      runTaskNotesProofManifest(root, ['--candidate', 'HEAD', '--verify-report', reportPath]),
    ).resolves.toMatch(/^task-notes-proof verified=[0-9a-f]{64}$/u);
  });

  it('rejects symbolic-link artifacts instead of hashing only their target text', async () => {
    createFixtureRepository();
    for (const artifactRoot of ['dist-electron', 'dist-remote', 'dist-server']) {
      write(`${artifactRoot}/app.js`, `export const artifact = '${artifactRoot}';\n`);
    }
    write('artifact-target.js', 'export const artifact = 1;\n');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.symlinkSync('../artifact-target.js', path.join(root, 'dist', 'app.js'));
    const snapshot = buildSourceSnapshot({ candidate: 'HEAD', projectRoot: root });
    const evidence = validateCommandEvidence(
      { commands: [{ command: 'npm test', exitCode: 0 }] },
      snapshot.seed.commands,
    );

    await expect(
      buildTaskNotesProofReport({
        evidence,
        projectRoot: root,
        snapshot,
        writerTrain: 'desktop',
      }),
    ).rejects.toThrow(/cannot be a symbolic link: dist\/app\.js/u);
  });

  it('requires writer reports to bind regular promotion files under release', async () => {
    createFixtureRepository();
    for (const artifactRoot of ['dist', 'dist-electron', 'dist-remote', 'dist-server']) {
      write(`${artifactRoot}/app.js`, `export const artifact = '${artifactRoot}';\n`);
    }
    const snapshot = buildSourceSnapshot({ candidate: 'HEAD', projectRoot: root });
    const evidence = validateCommandEvidence(
      { commands: [{ command: 'npm test', exitCode: 0 }] },
      snapshot.seed.commands,
    );

    await expect(
      buildTaskNotesProofReport({
        evidence,
        projectRoot: root,
        snapshot,
        writerTrain: 'desktop',
      }),
    ).rejects.toThrow(/require a promotion artifact/u);
    await expect(
      buildTaskNotesProofReport({
        evidence,
        projectRoot: root,
        promotionArtifactPaths: ['../escape.dmg'],
        snapshot,
        writerTrain: 'desktop',
      }),
    ).rejects.toThrow(/unsafe repository path/u);

    write('release/proof.txt', 'not a package\n');
    write('release/deceptive.dmg.txt', 'not a package\n');
    for (const unrelatedPath of ['release/proof.txt', 'release/deceptive.dmg.txt']) {
      await expect(
        buildTaskNotesProofReport({
          evidence,
          projectRoot: root,
          promotionArtifactPaths: [unrelatedPath],
          snapshot,
          writerTrain: 'desktop',
        }),
      ).rejects.toThrow(/not an approved release package or app\.asar/u);
    }

    fs.mkdirSync(path.join(root, 'release', 'directory', 'resources', 'app.asar'), {
      recursive: true,
    });
    await expect(
      buildTaskNotesProofReport({
        evidence,
        projectRoot: root,
        promotionArtifactPaths: ['release/directory/resources/app.asar'],
        snapshot,
        writerTrain: 'desktop',
      }),
    ).rejects.toThrow();

    write('outside.dmg', 'outside\n');
    fs.symlinkSync('../outside.dmg', path.join(root, 'release', 'linked.dmg'));
    await expect(
      buildTaskNotesProofReport({
        evidence,
        projectRoot: root,
        promotionArtifactPaths: ['release/linked.dmg'],
        snapshot,
        writerTrain: 'desktop',
      }),
    ).rejects.toThrow(/cannot contain a symbolic link/u);

    const externalRelease = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-proof-external-'));
    fs.mkdirSync(path.join(externalRelease, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(externalRelease, 'resources', 'app.asar'), 'external\n');
    fs.symlinkSync(externalRelease, path.join(root, 'release', 'linked-directory'));
    await expect(
      buildTaskNotesProofReport({
        evidence,
        projectRoot: root,
        promotionArtifactPaths: ['release/linked-directory/resources/app.asar'],
        snapshot,
        writerTrain: 'desktop',
      }),
    ).rejects.toThrow(/cannot contain a symbolic link/u);
    fs.rmSync(externalRelease, { force: true, recursive: true });
  });
});
