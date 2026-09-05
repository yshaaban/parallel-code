import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const objectivesDocPath = path.resolve(rootDir, 'docs/PRODUCT-VALIDATION-OBJECTIVES.md');
const auditDocPath = path.resolve(rootDir, 'docs/PRODUCT-GOAL-AUDIT-2026-05-08.md');
const testingDocPath = path.resolve(rootDir, 'docs/TESTING.md');
const ciWorkflowPath = path.resolve(rootDir, '.github/workflows/ci.yml');
const releaseWorkflowPath = path.resolve(rootDir, '.github/workflows/release.yml');
const packageJsonPath = path.resolve(rootDir, 'package.json');
const benchmarkConfigPath = path.resolve(rootDir, 'vitest.benchmark.config.ts');
const solidConfigPath = path.resolve(rootDir, 'vitest.solid.config.ts');
const sourceRootsWithArchitectureGuards = ['electron', 'server', 'src', 'tests'] as const;
const architectureGuardFilePattern = /\.architecture\.test\.tsx?$/u;
const performanceGateFilePattern =
  /(?:\.bench(?:mark)?\.test|\.performance\.test|-bundle-budget\.test)\.tsx?$/u;
const mandatoryVitestBenchmarkGatePaths = [
  'server/task-content-authority-coordinator.benchmark.ts',
  'src/app/task-git-action-capability.benchmark.ts',
  'src/components/new-task-dialog/new-task-draft.benchmark.ts',
  'src/components/task-notes/task-notes-controller.benchmark.ts',
  'src/domain/new-task-defaults.benchmark.ts',
  'src/lib/terminal-links.benchmark.ts',
  'src/lib/webglPool.benchmark.ts',
] as const;
const serverIntegrationPaths = [
  'server/terminal-latency.test.ts',
  'server/session-stress.test.ts',
  'server/boot-pipeline.test.ts',
  'tests/contracts/review-diff.contract.test.ts',
  'tests/harness/standalone-server.test.ts',
] as const;
const coordinatorE2ePath = 'tests/coordinator/coordinator-browserless-e2e.test.ts';
const browserArtifactPreparationScriptNames = [
  'prepare:browser-artifacts',
  'build:frontend',
  'build:remote',
  'build:server',
] as const;
const activeFeatureBrowserSpecPaths = [
  'tests/browser/accessibility-preferences.spec.ts',
  'tests/browser/agent-resume-fallback.spec.ts',
  'tests/browser/initial-prompt-delivery.spec.ts',
  'tests/browser/initial-prompt-delivery-performance.spec.ts',
  'tests/browser/multiclient-control.spec.ts',
  'tests/browser/new-task-dialog.spec.ts',
  'tests/browser/parallel-project-root-tasks.spec.ts',
  'tests/browser/prompt-question-drafting.spec.ts',
  'tests/browser/prompt-question-drafting-performance.spec.ts',
  'tests/browser/remote-bootstrap.spec.ts',
  'tests/browser/remote-mobile-session.spec.ts',
  'tests/browser/remote-task-creation.spec.ts',
  'tests/browser/remote-task-creation-performance.spec.ts',
  'tests/browser/remote-task-notes.spec.ts',
  'tests/browser/task-notes-performance.spec.ts',
  'tests/browser/task-merge-progress.spec.ts',
  'tests/browser/task-merge-progress-performance.spec.ts',
  'tests/browser/terminal-links.spec.ts',
  'tests/browser/terminal-search.spec.ts',
  'tests/browser/terminal-search-performance.spec.ts',
  'tests/browser/terminal-webgl-repaint.spec.ts',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function readPackageScripts(): Record<string, string> {
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(packageJson) || !isStringRecord(packageJson.scripts)) {
    throw new Error('package.json scripts must be a string record');
  }

  return packageJson.scripts;
}

function extractDocumentedNpmScripts(markdown: string): string[] {
  const scripts = new Set<string>();
  const commandPattern = /`npm (?:(?:run )([^\s`]+)|test)(?:\s[^`]*)?`/gu;
  let match = commandPattern.exec(markdown);
  while (match !== null) {
    const scriptName = match[1] ?? 'test';
    if (scriptName) {
      scripts.add(scriptName);
    }
    match = commandPattern.exec(markdown);
  }

  return [...scripts].sort();
}

function extractDocumentedTestPaths(markdown: string): string[] {
  const paths = new Set<string>();
  const commandPattern = /`npm run [^`]+`/gu;
  let commandMatch = commandPattern.exec(markdown);
  while (commandMatch !== null) {
    const command = commandMatch[0].slice(1, -1);
    for (const token of command.split(/\s+/u)) {
      if (/^(electron|server|src|tests)\/.+\.(test|spec)\.tsx?$/u.test(token)) {
        paths.add(token);
      }
    }
    commandMatch = commandPattern.exec(markdown);
  }

  return [...paths].sort();
}

function extractSection(markdown: string, heading: string): string {
  const sectionPattern = new RegExp(
    `(?:^|\\n)## ${heading}\\n\\n(?<body>[\\s\\S]*?)(?=\\n## |$)`,
    'u',
  );
  const match = sectionPattern.exec(markdown);

  return match?.groups?.body.trim() ?? '';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ');
}

function tokenizePackageScript(command: string): string[] {
  return command
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/^(?<quote>['"])(?<value>.*)\k<quote>$/u, '$<value>'));
}

function countScriptToken(command: string, expectedToken: string): number {
  return tokenizePackageScript(command).filter((token) => token === expectedToken).length;
}

function countExcludedScriptToken(command: string, expectedToken: string): number {
  const tokens = tokenizePackageScript(command);
  return tokens.reduce(
    (count, token, index) =>
      token === '--exclude' && tokens[index + 1] === expectedToken ? count + 1 : count,
    0,
  );
}

function countLiteralOccurrences(text: string, expected: string): number {
  if (expected.length === 0) {
    return 0;
  }

  return text.split(expected).length - 1;
}

function readValidationDocs(): string {
  return [objectivesDocPath, auditDocPath]
    .map((documentPath) => readFileSync(documentPath, 'utf8'))
    .join('\n');
}

function listRepositoryPathsMatching(relativePath: string, pattern: RegExp): string[] {
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!existsSync(absolutePath)) {
    return [];
  }

  return readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => {
      const childPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        return listRepositoryPathsMatching(childPath, pattern);
      }

      if (!entry.isFile() || !pattern.test(childPath)) {
        return [];
      }

      return [childPath];
    })
    .sort();
}

function listRepositoryArchitectureGuardPaths(): string[] {
  return sourceRootsWithArchitectureGuards
    .flatMap((root) => listRepositoryPathsMatching(root, architectureGuardFilePattern))
    .sort();
}

function listRepositoryPerformanceGatePaths(): string[] {
  return sourceRootsWithArchitectureGuards
    .flatMap((root) => listRepositoryPathsMatching(root, performanceGateFilePattern))
    .sort();
}

describe('product validation objectives', () => {
  it('keeps the active goal focused on user experience and ownership guardrails', () => {
    const markdown = readFileSync(objectivesDocPath, 'utf8');
    const activeGoal = normalizeWhitespace(extractSection(markdown, 'Active Goal'));

    expect(activeGoal).toContain('browser-first developer cockpit');
    expect(activeGoal).toContain('selected task, terminal, diff, preview, and remote session');
    expect(activeGoal).toContain('immediately usable and desktop-native even under load');
    expect(activeGoal).toContain('no ambiguity about who controls the task');
    expect(activeGoal).toContain('Browser/server mode is the product baseline');
    expect(activeGoal).toContain('Electron is only a platform adapter');
    expect(activeGoal).toContain('explicit preview and port exposure');
    expect(activeGoal).toContain('backend owns external truth');
    expect(activeGoal).toContain('renderer owns presentation and workflow');
    expect(activeGoal).toContain('transport never owns domain policy');
    expect(activeGoal).toContain('cheapest reliable owner-local proof');
    expect(activeGoal).toContain('real browser tests for risks that only a browser can expose');
    expect(activeGoal).toContain('focus, paint, navigation, cookies, websocket auth/bootstrap');
    expect(activeGoal).toContain('multi-context coordination');
  });

  it('keeps documented npm proof lanes backed by package scripts', () => {
    const markdown = readValidationDocs();
    const packageScripts = readPackageScripts();
    const documentedScripts = extractDocumentedNpmScripts(markdown);

    expect(documentedScripts).toEqual(
      expect.arrayContaining([
        'check',
        'format:check',
        'profile:review:diffs',
        'profile:terminal:ui-fluidity:dense-gate',
        'profile:terminal:ui-fluidity:gate',
        'test',
        'test:architecture-guards',
        'test:browser:canaries',
        'test:browser:preview',
        'test:browser:remote',
        'test:browser:task-deletion',
        'test:browser:terminal',
        'test:node:file',
        'test:solid:file',
        'test:validation-guards',
        'validate:pr-description',
      ]),
    );

    for (const scriptName of documentedScripts) {
      expect(packageScripts[scriptName], `package.json script ${scriptName}`).toEqual(
        expect.any(String),
      );
    }
  });

  it('keeps the release build anchored on browser/server artifacts before packaging Electron', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts.build).toBe('node scripts/build-release.mjs');
    expect(existsSync(path.resolve(rootDir, 'scripts/build-release.mjs'))).toBe(true);
  });

  it('keeps the local check lane protecting architecture ownership guardrails', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts.typecheck).toContain('npm run typecheck:server');
    expect(packageScripts.check).toContain('npm run typecheck');
    expect(packageScripts.check).toContain('npm run lint');
    expect(packageScripts.check).toContain('npm run format:check');
    expect(packageScripts.check).toContain('npm run test:architecture-guards');
  });

  it('keeps every architecture guard file in the fast architecture lane', () => {
    const packageScripts = readPackageScripts();
    const architectureGuardPaths = listRepositoryArchitectureGuardPaths();

    expect(architectureGuardPaths.length).toBeGreaterThan(0);
    for (const guardPath of architectureGuardPaths) {
      expect(packageScripts['test:architecture-guards'], guardPath).toContain(guardPath);
    }
  });

  it('keeps every deterministic performance budget in a serial mandatory lane', () => {
    const packageScripts = readPackageScripts();
    const performanceGatePaths = listRepositoryPerformanceGatePaths();
    const nodePerformanceGatePaths = [
      ...performanceGatePaths.filter((gatePath) => gatePath.endsWith('.ts')),
      ...mandatoryVitestBenchmarkGatePaths,
    ].sort();
    const solidPerformanceGatePaths = performanceGatePaths.filter((gatePath) =>
      gatePath.endsWith('.tsx'),
    );
    const serialGate = packageScripts['test:performance-gates:run'];
    const dedicatedNodeOwnerLanes = [
      serialGate,
      packageScripts['test:node:server-integration:run'],
      packageScripts['test:node:coordinator:e2e'],
    ];
    const broadNodeLane = packageScripts['test:node:default'];
    const benchmarkConfig = readFileSync(benchmarkConfigPath, 'utf8');
    const solidConfig = readFileSync(solidConfigPath, 'utf8');

    expect(performanceGatePaths.length).toBeGreaterThan(0);
    expect(countScriptToken(packageScripts['test:node'], 'test:performance-gates:run')).toBe(1);
    expect(countScriptToken(serialGate, '--no-file-parallelism')).toBe(2);
    expect(countExcludedScriptToken(broadNodeLane, '**/*.bench.test.ts')).toBe(1);
    expect(countExcludedScriptToken(broadNodeLane, '**/*.benchmark.test.ts')).toBe(1);
    expect(countExcludedScriptToken(broadNodeLane, '**/*.performance.test.ts')).toBe(1);
    for (const gatePath of nodePerformanceGatePaths) {
      expect(existsSync(path.resolve(rootDir, gatePath)), gatePath).toBe(true);
      expect(
        dedicatedNodeOwnerLanes.reduce(
          (count, command) => count + countScriptToken(command, gatePath),
          0,
        ),
        gatePath,
      ).toBe(1);
      expect(countScriptToken(serialGate, gatePath), gatePath).toBe(1);
      if (gatePath.includes('bundle-budget.test.')) {
        expect(countExcludedScriptToken(broadNodeLane, gatePath), gatePath).toBe(1);
      }
    }
    for (const gatePath of mandatoryVitestBenchmarkGatePaths) {
      expect(countLiteralOccurrences(benchmarkConfig, `'${gatePath}'`), gatePath).toBe(1);
    }
    if (solidPerformanceGatePaths.length > 0) {
      expect(countScriptToken(packageScripts.test, 'test:solid')).toBe(1);
      expect(packageScripts['test:solid']).toContain('vitest.solid.config.ts');
      expect(solidConfig).toContain("include: ['src/**/*.test.tsx']");
      expect(solidConfig).toContain('fileParallelism: false');
    }
  });

  it('keeps live standalone route harnesses in mandatory serial lanes', () => {
    const packageScripts = readPackageScripts();
    const broadNodeLane = packageScripts['test:node:default'];
    const nodeLane = packageScripts['test:node'];
    const serverIntegrationWrapper = packageScripts['test:node:server-integration'];
    const serverIntegrationLane = packageScripts['test:node:server-integration:run'];
    const coordinatorLane = packageScripts['test:node:coordinator:e2e'];
    const dedicatedNodeOwnerLanes = [
      packageScripts['test:performance-gates:run'],
      serverIntegrationLane,
      coordinatorLane,
    ];

    expect(countScriptToken(nodeLane, 'prepare:browser-artifacts')).toBe(1);
    expect(countScriptToken(nodeLane, 'test:node:server-integration:run')).toBe(1);
    expect(countScriptToken(nodeLane, 'test:node:server-integration')).toBe(0);
    expect(countScriptToken(nodeLane, 'test:node:coordinator:e2e')).toBe(1);
    expect(countScriptToken(serverIntegrationWrapper, 'prepare:browser-artifacts')).toBe(1);
    expect(countScriptToken(serverIntegrationWrapper, 'test:node:server-integration:run')).toBe(1);
    for (const preparationScript of browserArtifactPreparationScriptNames) {
      expect(countScriptToken(serverIntegrationLane, preparationScript), preparationScript).toBe(0);
    }
    expect(countScriptToken(serverIntegrationLane, '--no-file-parallelism')).toBe(1);
    expect(countScriptToken(coordinatorLane, '--no-file-parallelism')).toBe(1);
    for (const testPath of serverIntegrationPaths) {
      expect(
        dedicatedNodeOwnerLanes.reduce(
          (count, command) => count + countScriptToken(command, testPath),
          0,
        ),
        testPath,
      ).toBe(1);
      expect(countExcludedScriptToken(broadNodeLane, testPath), testPath).toBe(1);
    }
    expect(
      dedicatedNodeOwnerLanes.reduce(
        (count, command) => count + countScriptToken(command, coordinatorE2ePath),
        0,
      ),
    ).toBe(1);
    expect(countExcludedScriptToken(broadNodeLane, coordinatorE2ePath)).toBe(1);

    expect(countScriptToken(packageScripts['test:harness'], 'prepare:browser-artifacts')).toBe(1);
    expect(countScriptToken(packageScripts['test:harness'], '--no-file-parallelism')).toBe(1);
    for (const aggregate of ['test:contracts', 'test:contracts:lifecycle', 'test:reliability']) {
      const runLane = `${aggregate}:run`;
      expect(
        countScriptToken(packageScripts[aggregate], 'prepare:browser-artifacts'),
        aggregate,
      ).toBe(1);
      expect(countScriptToken(packageScripts[aggregate], runLane), aggregate).toBe(1);
      for (const preparationScript of browserArtifactPreparationScriptNames) {
        expect(countScriptToken(packageScripts[runLane], preparationScript), runLane).toBe(0);
      }
      expect(
        countScriptToken(packageScripts[runLane], '--no-file-parallelism'),
        runLane,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the active-feature browser acceptance inventory exact and mandatory', () => {
    const packageScripts = readPackageScripts();
    const activeFeatureLane = packageScripts['test:browser:active-features'];
    const activeFeatureTokens = tokenizePackageScript(activeFeatureLane);
    const configuredSpecPaths = activeFeatureTokens
      .filter((token) => /^tests\/browser\/.+\.spec\.ts$/u.test(token))
      .sort();
    const expectedSpecPaths = [...activeFeatureBrowserSpecPaths].sort();
    const ciWorkflow = readFileSync(ciWorkflowPath, 'utf8');
    const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8');
    const testingDoc = readFileSync(testingDocPath, 'utf8');

    expect(configuredSpecPaths).toEqual(expectedSpecPaths);
    for (const specPath of activeFeatureBrowserSpecPaths) {
      expect(existsSync(path.resolve(rootDir, specPath)), specPath).toBe(true);
      expect(countScriptToken(activeFeatureLane, specPath), specPath).toBe(1);
    }
    expect(countScriptToken(activeFeatureLane, 'test:browser:run')).toBe(1);
    expect(countScriptToken(activeFeatureLane, '--workers=1')).toBe(1);
    expect(countScriptToken(activeFeatureLane, '--project')).toBe(1);
    expect(countScriptToken(activeFeatureLane, 'chromium')).toBe(1);

    for (const [workflowName, workflow] of [
      ['CI', ciWorkflow],
      ['release', releaseWorkflow],
    ] as const) {
      const nodeTestIndex = workflow.indexOf('npm test');
      const activeFeatureIndex = workflow.indexOf('npm run test:browser:active-features');

      expect(
        countLiteralOccurrences(workflow, 'npm run test:browser:active-features'),
        workflowName,
      ).toBe(1);
      expect(nodeTestIndex, workflowName).toBeGreaterThanOrEqual(0);
      expect(activeFeatureIndex, workflowName).toBeGreaterThan(nodeTestIndex);
    }

    expect(testingDoc).toContain(
      '`test:browser:active-features` is the deterministic, single-worker acceptance owner',
    );
    expect(testingDoc).toContain('CI and release preflight run it after `npm test`');
  });

  it('keeps long-lived control-plane stress in the lifecycle contract lane', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:contracts:lifecycle:run']).toContain(
      'tests/contracts/control-plane-stress.contract.test.ts',
    );
    expect(packageScripts['test:contracts:lifecycle:run']).toContain(
      'server/browser-control-plane.test.ts',
    );
  });

  it('keeps selected-surface attach scheduling in the lifecycle contract lane', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:contracts:lifecycle:run']).toContain(
      'src/app/terminal-attach-scheduler.test.ts',
    );
    expect(packageScripts['test:contracts:lifecycle:run']).toContain(
      'src/app/session-bootstrap-controller.test.ts',
    );
  });

  it('keeps resize authority proof in owner-local lifecycle lanes', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:node:server-integration:run']).toContain(
      'server/session-stress.test.ts',
    );
    expect(packageScripts['test:contracts:lifecycle:run']).toContain(
      'src/components/terminal-view/terminal-input-pipeline.test.ts',
    );
  });

  it('keeps preview browser proof focused on the exposed-preview canary', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:browser:preview']).toContain('tests/browser/preview-proxy.spec.ts');
    expect(packageScripts['test:browser:preview']).toContain('--project chromium');
    expect(packageScripts['test:browser:preview']).toContain('--workers=1');
  });

  it('keeps task deletion browser proof focused on the review and preview cleanup canary', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:browser:task-deletion']).toContain(
      'tests/browser/task-deletion-lifecycle.spec.ts',
    );
    expect(packageScripts['test:browser:task-deletion']).toContain('--project chromium');
    expect(packageScripts['test:browser:task-deletion']).toContain('--workers=1');
  });

  it('keeps release workflow builds routed through the release orchestrator', () => {
    const workflow = readFileSync(releaseWorkflowPath, 'utf8');
    const preflightIndex = workflow.indexOf('preflight:');
    const createReleaseIndex = workflow.indexOf('create-release:');
    const checkIndex = workflow.indexOf('npm run check');
    const testIndex = workflow.indexOf('npm test');
    const linuxBuildIndex = workflow.indexOf('npm run build -- --publish never');
    const macBuildIndex = workflow.indexOf('npm run build -- --universal --publish never');

    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(checkIndex).toBeGreaterThan(preflightIndex);
    expect(testIndex).toBeGreaterThan(checkIndex);
    expect(createReleaseIndex).toBeGreaterThan(testIndex);
    expect(workflow).toContain('needs: preflight');
    expect(linuxBuildIndex).toBeGreaterThan(createReleaseIndex);
    expect(macBuildIndex).toBeGreaterThan(createReleaseIndex);
    expect(workflow).not.toMatch(/(?:^|\s)(?:npx\s+)?electron-builder(?:\s|$)/u);
  });

  it('keeps the remote deploy smoke utility covered by validation guards', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['smoke:remote']).toBe('node scripts/smoke-remote-bootstrap.mjs');
    expect(packageScripts['test:validation-guards']).toContain(
      'tests/harness/smoke-remote-bootstrap.test.ts',
    );
  });

  it('keeps PR description validation wired to pull request bodies in CI', () => {
    const workflow = readFileSync(ciWorkflowPath, 'utf8');
    const validationIndex = workflow.indexOf('npm run validate:pr-description');
    const guardTestIndex = workflow.indexOf('npm run test:validation-guards');
    const checkIndex = workflow.indexOf('npm run check');
    const testIndex = workflow.indexOf('npm test');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(guardTestIndex).toBeGreaterThan(validationIndex);
    expect(checkIndex).toBeGreaterThan(guardTestIndex);
    expect(testIndex).toBeGreaterThan(checkIndex);
  });

  it('keeps documented targeted test paths present in the repository', () => {
    const markdown = readValidationDocs();
    const documentedPaths = extractDocumentedTestPaths(markdown);

    expect(documentedPaths).toEqual(
      expect.arrayContaining([
        'electron/ipc/task-ports.test.ts',
        'server/browser-preview.test.ts',
        'src/app/desktop-session.test.ts',
        'src/app/review-diffs.test.ts',
        'src/app/review-files.test.ts',
        'src/app/server-state-bootstrap.test.ts',
        'src/app/session-bootstrap-controller.test.ts',
        'src/app/task-ports.test.ts',
        'src/app/terminal-attach-scheduler.test.ts',
        'src/app/terminal-focused-input.test.ts',
        'src/app/terminal-output-scheduler-policy.test.ts',
        'src/components/PreviewPanel.test.tsx',
        'src/components/ReviewPanel.test.tsx',
        'src/components/terminal-view/terminal-input-pipeline.test.ts',
        'tests/contracts/control-plane-stress.contract.test.ts',
        'tests/contracts/review-diff.contract.test.ts',
      ]),
    );

    for (const testPath of documentedPaths) {
      expect(existsSync(path.resolve(rootDir, testPath)), testPath).toBe(true);
    }
  });
});
