import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const objectivesDocPath = path.resolve(rootDir, 'docs/PRODUCT-VALIDATION-OBJECTIVES.md');
const auditDocPath = path.resolve(rootDir, 'docs/PRODUCT-GOAL-AUDIT-2026-05-08.md');
const ciWorkflowPath = path.resolve(rootDir, '.github/workflows/ci.yml');
const packageJsonPath = path.resolve(rootDir, 'package.json');

interface PackageJson {
  scripts: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
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
    const packageJson = readPackageJson();
    const documentedScripts = extractDocumentedNpmScripts(markdown);

    expect(documentedScripts).toEqual(
      expect.arrayContaining([
        'check',
        'format:check',
        'profile:review:diffs',
        'profile:terminal:ui-fluidity:dense-gate',
        'profile:terminal:ui-fluidity:gate',
        'test',
        'test:browser:canaries',
        'test:browser:remote',
        'test:browser:terminal',
        'test:node:file',
        'test:solid:file',
        'test:validation-guards',
        'validate:pr-description',
      ]),
    );

    for (const scriptName of documentedScripts) {
      expect(packageJson.scripts[scriptName], `package.json script ${scriptName}`).toEqual(
        expect.any(String),
      );
    }
  });

  it('keeps PR description validation wired to pull request bodies in CI', () => {
    const workflow = readFileSync(ciWorkflowPath, 'utf8');
    const validationIndex = workflow.indexOf('npm run validate:pr-description');
    const guardTestIndex = workflow.indexOf('npm run test:validation-guards');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(guardTestIndex).toBeGreaterThan(validationIndex);
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
        'tests/contracts/review-diff.contract.test.ts',
      ]),
    );

    for (const testPath of documentedPaths) {
      expect(existsSync(path.resolve(rootDir, testPath)), testPath).toBe(true);
    }
  });
});
