import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const objectivesDocPath = path.resolve(rootDir, 'docs/PRODUCT-VALIDATION-OBJECTIVES.md');
const auditDocPath = path.resolve(rootDir, 'docs/PRODUCT-GOAL-AUDIT-2026-05-08.md');
const ciWorkflowPath = path.resolve(rootDir, '.github/workflows/ci.yml');
const releaseWorkflowPath = path.resolve(rootDir, '.github/workflows/release.yml');
const packageJsonPath = path.resolve(rootDir, 'package.json');
const sourceRootsWithArchitectureGuards = ['electron', 'server', 'src', 'tests'] as const;
const architectureGuardFilePattern = /\.architecture\.test\.tsx?$/u;

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

function readValidationDocs(): string {
  return [objectivesDocPath, auditDocPath]
    .map((documentPath) => readFileSync(documentPath, 'utf8'))
    .join('\n');
}

function listArchitectureGuardPaths(relativePath: string): string[] {
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!existsSync(absolutePath)) {
    return [];
  }

  return readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => {
      const childPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        return listArchitectureGuardPaths(childPath);
      }

      if (!entry.isFile() || !architectureGuardFilePattern.test(childPath)) {
        return [];
      }

      return [childPath];
    })
    .sort();
}

function listRepositoryArchitectureGuardPaths(): string[] {
  return sourceRootsWithArchitectureGuards.flatMap(listArchitectureGuardPaths).sort();
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

  it('keeps long-lived control-plane stress in the lifecycle contract lane', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:contracts:lifecycle']).toContain(
      'tests/contracts/control-plane-stress.contract.test.ts',
    );
    expect(packageScripts['test:contracts:lifecycle']).toContain(
      'server/browser-control-plane.test.ts',
    );
  });

  it('keeps selected-surface attach scheduling in the lifecycle contract lane', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:contracts:lifecycle']).toContain(
      'src/app/terminal-attach-scheduler.test.ts',
    );
    expect(packageScripts['test:contracts:lifecycle']).toContain(
      'src/app/session-bootstrap-controller.test.ts',
    );
  });

  it('keeps resize authority proof in owner-local lifecycle lanes', () => {
    const packageScripts = readPackageScripts();

    expect(packageScripts['test:node:server-integration']).toContain(
      'server/session-stress.test.ts',
    );
    expect(packageScripts['test:contracts:lifecycle']).toContain(
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
