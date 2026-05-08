import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  OWNERSHIP_LABELS,
  STATE_AND_CONTROL_LABELS,
} from '../../scripts/validate-pr-description.mjs';

const scriptPath = path.resolve(process.cwd(), 'scripts/validate-pr-description.mjs');
const pullRequestTemplatePath = path.resolve(process.cwd(), '.github/PULL_REQUEST_TEMPLATE.md');

interface PullRequestBodyOptions {
  browserProofRun?: string;
  browserSkipReason?: string;
  evidence?: string;
  frustration?: string;
  ownershipChoices?: string;
  productObjective?: string;
  responsivenessRisk?: string;
  stateAndControlChoices?: string;
  targetedProof?: string;
}

function runValidator(body: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PR_BODY: body,
    },
  });
}

function runValidatorForFile(filePath: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [scriptPath, '--file', filePath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
}

function getTemplateSection(markdown: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, 'mu');
  const match = pattern.exec(markdown);
  if (!match) {
    return '';
  }

  const sectionStartIndex = match.index + match[0].length;
  const remainingMarkdown = markdown.slice(sectionStartIndex);
  const nextSectionIndex = remainingMarkdown.search(/^##\s+/mu);
  if (nextSectionIndex === -1) {
    return remainingMarkdown;
  }

  return remainingMarkdown.slice(0, nextSectionIndex);
}

function getTemplateCheckboxLabels(markdown: string, heading: string): string[] {
  const labels: string[] = [];
  const section = getTemplateSection(markdown, heading);
  const checkboxPattern = /^-\s+\[[ xX]\]\s+(.+)$/gmu;
  let match = checkboxPattern.exec(section);

  while (match !== null) {
    const label = match[1]?.trim();
    if (label) {
      labels.push(label);
    }
    match = checkboxPattern.exec(section);
  }

  return labels;
}

function createPullRequestBody(options: PullRequestBodyOptions = {}): string {
  const frustration = options.frustration ?? 'I typed and it lagged.';
  const productObjective = options.productObjective ?? 'Terminal input remains latency-critical.';
  const ownershipChoices = options.ownershipChoices ?? '- [x] Workflow / app\n- [ ] Presentation';
  const stateAndControlChoices =
    options.stateAndControlChoices ??
    '- [x] Who controls the task or terminal\n- [ ] Not applicable';
  const targetedProof =
    options.targetedProof ??
    'npx vitest run --config vitest.config.ts src/app/terminal-focused-input.test.ts';
  const browserProofRun =
    options.browserProofRun ?? 'not run: no real focus, paint, cookie, or websocket path changed';
  const browserSkipReason =
    options.browserSkipReason ?? 'no real focus, paint, cookie, or websocket path changed';
  const responsivenessRisk =
    options.responsivenessRisk ?? 'terminal input could lose priority under background output.';
  const evidence =
    options.evidence ?? 'owner-local latency test covers the governor state transition.';

  return `
## Product Frustration

- Frustration: ${frustration}
- Product objective: ${productObjective}

## Ownership

${ownershipChoices}

Notes:

## State And Control

${stateAndControlChoices}

Notes:

## Validation

- Targeted proof: ${targetedProof}
- Broad proof: npm run test:node
- Browser proof run: ${browserProofRun}
- Browser lanes intentionally not run, with reason: ${browserSkipReason}

## Performance And Responsiveness

- Responsiveness risk: ${responsivenessRisk}
- Evidence: ${evidence}
`;
}

describe('PR description validation', () => {
  it('keeps the checked-in template aligned with product validation priorities', () => {
    const template = readFileSync(pullRequestTemplatePath, 'utf8');

    expect(template).toContain('What is blocked and why');
    expect(template).toContain('selected surface stays useful immediately');
    expect(template).toContain('terminal input remains');
    expect(template).toContain('responsive under load');
    expect(template).toContain('Only add browser proof when the risk needs a real browser');
    expect(template).toContain('start the browser proof line with `not run:`');
    expect(template).toContain('Manual browser proof');
  });

  it('keeps checked-in template checkbox labels aligned with validator labels', () => {
    const template = readFileSync(pullRequestTemplatePath, 'utf8');

    expect(getTemplateCheckboxLabels(template, 'Ownership')).toEqual([...OWNERSHIP_LABELS]);
    expect(getTemplateCheckboxLabels(template, 'State And Control')).toEqual([
      ...STATE_AND_CONTROL_LABELS,
    ]);
  });

  it('accepts product validation notes with owner, state, proof, and responsiveness fields', () => {
    const result = runValidator(createPullRequestBody());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('required product validation fields');
  });

  it('rejects required fields placed outside their owning sections', () => {
    const result = runValidator(`
## Product Frustration

## Ownership

- [x] Docs / tooling only

## State And Control

- [x] Not applicable

## Validation

- Frustration: Slow gates delay fixes to daily pain.
- Product objective: Use the cheapest valid seam first.
- Targeted proof: npm run test:validation-guards
- Broad proof: npm run check
- Browser proof run: not run: no browser focus, paint, navigation, cookies, websocket auth, or multi-context path changed
- Browser lanes intentionally not run, with reason: no browser focus, paint, navigation, cookies, websocket auth, or multi-context path changed
- Responsiveness risk: review validation could force expensive browser gates for docs-only work.
- Evidence: validation guard tests cover docs-only review notes.

## Performance And Responsiveness
`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing field value: Frustration');
    expect(result.stderr).toContain('Missing field value: Product objective');
    expect(result.stderr).toContain('Missing field value: Responsiveness risk');
    expect(result.stderr).toContain('Missing field value: Evidence');
  });

  it('rejects state/control notes that combine Not applicable with concrete state', () => {
    const result = runValidator(
      createPullRequestBody({
        evidence: 'owner-local port state test covers snapshot-first preview behavior.',
        frustration: 'The app exposed something unexpectedly.',
        ownershipChoices: '- [x] Backend / external truth',
        productObjective: 'Preview exposure remains explicit and visible.',
        responsivenessRisk: 'preview opening could block on unnecessary rescans.',
        stateAndControlChoices: '- [x] What is exposed\n- [x] Not applicable',
        targetedProof: 'npm run test:node:file -- src/app/task-ports.test.ts',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Do not combine Not applicable with other state/control checkboxes.',
    );
  });

  it('rejects docs-only ownership combined with runtime ownership', () => {
    const result = runValidator(
      createPullRequestBody({
        evidence: 'validation guard tests cover the product review checklist.',
        frustration: 'Slow gates delay fixes to daily pain.',
        ownershipChoices: '- [x] Docs / tooling only\n- [x] Handler / transport',
        productObjective: 'Use the cheapest valid seam first.',
        responsivenessRisk:
          'review notes could overstate proof and trigger unnecessary browser work.',
        stateAndControlChoices: '- [x] Not applicable',
        targetedProof: 'npm run test:validation-guards',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Do not combine Docs / tooling only with runtime ownership checkboxes.',
    );
  });

  it('rejects docs-only ownership with concrete state/control selections', () => {
    const result = runValidator(
      createPullRequestBody({
        evidence: 'validation guard tests cover the product review checklist.',
        frustration: 'Slow gates delay fixes to daily pain.',
        ownershipChoices: '- [x] Docs / tooling only',
        productObjective: 'Use the cheapest valid seam first.',
        responsivenessRisk:
          'review notes could overstate product state changes for docs-only work.',
        stateAndControlChoices: '- [x] What is stale',
        targetedProof: 'npm run test:validation-guards',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Docs / tooling only changes should mark state/control as Not applicable.',
    );
  });

  it('rejects unknown ownership and state/control checkbox labels', () => {
    const result = runValidator(
      createPullRequestBody({
        ownershipChoices: '- [x] Runtime-ish owner',
        stateAndControlChoices: '- [x] Something changed somewhere',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown ownership checkbox: Runtime-ish owner');
    expect(result.stderr).toContain('Unknown state/control checkbox: Something changed somewhere');
  });

  it('rejects skipped browser proof without a specific skip reason', () => {
    const genericSkipReasons = ['none', 'not required', 'because not needed'];

    for (const browserSkipReason of genericSkipReasons) {
      const result = runValidator(
        createPullRequestBody({
          browserSkipReason,
          evidence: 'runtime state-machine test covers the blocked transition.',
          frustration: 'It works in Electron but not in browser.',
          ownershipChoices: '- [x] Handler / transport',
          productObjective: 'Browser correctness remains a release promise.',
          responsivenessRisk: 'reconnect state could remain blocked without a visible owner.',
          stateAndControlChoices: '- [x] What is blocked and why',
          targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
        }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Explain why browser lanes were intentionally not run.');
    }
  });

  it('accepts explicit skipped browser proof wording with a specific skip reason', () => {
    const result = runValidator(
      createPullRequestBody({
        browserProofRun:
          'not run: no browser focus, paint, navigation, cookies, websocket auth, or multi-context path changed',
        browserSkipReason:
          'no browser focus, paint, navigation, cookies, websocket auth, or multi-context path changed',
        evidence: 'validation guard tests cover the docs-only review checklist.',
        frustration: 'Slow gates delay fixes to daily pain.',
        ownershipChoices: '- [x] Docs / tooling only',
        productObjective: 'Use the cheapest valid seam first.',
        responsivenessRisk:
          'review validation could force expensive browser gates for docs-only work.',
        stateAndControlChoices: '- [x] Not applicable',
        targetedProof: 'npm run test:validation-guards',
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('required product validation fields');
  });

  it('rejects ambiguous skipped browser proof wording even with a specific skip reason', () => {
    const ambiguousBrowserProofRuns = [
      'not needed',
      'none',
      'did not run browser tests',
      'not run - no browser runtime behavior changed',
    ];

    for (const browserProofRun of ambiguousBrowserProofRuns) {
      const result = runValidator(
        createPullRequestBody({
          browserProofRun,
          browserSkipReason:
            'no browser focus, paint, navigation, cookies, websocket auth, or multi-context path changed',
          evidence: 'validation guard tests cover the docs-only review checklist.',
          frustration: 'Slow gates delay fixes to daily pain.',
          ownershipChoices: '- [x] Docs / tooling only',
          productObjective: 'Use the cheapest valid seam first.',
          responsivenessRisk:
            'review validation could force expensive browser gates for docs-only work.',
          stateAndControlChoices: '- [x] Not applicable',
          targetedProof: 'npm run test:validation-guards',
        }),
      );

      expect(result.status, browserProofRun).toBe(1);
      expect(result.stderr).toContain('Skipped browser proof must start with `not run:`.');
    }
  });

  it('rejects generic non-answers in required product validation fields', () => {
    const result = runValidator(
      createPullRequestBody({
        evidence: 'see above',
        productObjective: 'n/a',
        responsivenessRisk: 'none',
        targetedProof: 'tbd',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing field value: Product objective');
    expect(result.stderr).toContain('Missing field value: Targeted proof');
    expect(result.stderr).toContain('Missing field value: Responsiveness risk');
    expect(result.stderr).toContain('Missing field value: Evidence');
  });

  it('allows no skipped browser lanes when browser proof was run', () => {
    const browserProofRuns = [
      'npm run test:browser:canaries',
      'npm run test:browser:file -- tests/browser/terminal-input.spec.ts --project chromium --workers=1',
      'npx playwright test tests/browser/terminal-input.spec.ts --project chromium --workers=1',
    ];

    for (const browserProofRun of browserProofRuns) {
      const result = runValidator(
        createPullRequestBody({
          browserProofRun,
          browserSkipReason: 'none',
          evidence: 'browser canary covered reconnect visibility.',
          frustration: 'It works in Electron but not in browser.',
          ownershipChoices: '- [x] Handler / transport',
          productObjective: 'Browser correctness remains a release promise.',
          responsivenessRisk: 'reconnect state could remain blocked without a visible owner.',
          stateAndControlChoices: '- [x] What is blocked and why',
          targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
        }),
      );

      expect(result.status, browserProofRun).toBe(0);
      expect(result.stdout).toContain('required product validation fields');
    }
  });

  it('accepts structured manual browser proof when browser-only risk was checked manually', () => {
    const result = runValidator(
      createPullRequestBody({
        browserProofRun:
          'manual browser: Chromium reconnect visibility checked against local server',
        browserSkipReason: 'none',
        evidence: 'manual browser proof covered reconnect visibility before review.',
        frustration: 'It works in Electron but not in browser.',
        ownershipChoices: '- [x] Handler / transport',
        productObjective: 'Browser correctness remains a release promise.',
        responsivenessRisk: 'reconnect state could remain blocked without a visible owner.',
        stateAndControlChoices: '- [x] What is blocked and why',
        targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('required product validation fields');
  });

  it('rejects non-browser proof listed as browser proof', () => {
    const result = runValidator(
      createPullRequestBody({
        browserProofRun: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
        browserSkipReason: 'none',
        evidence: 'browser session unit coverage exercised the state-machine owner.',
        frustration: 'It works in Electron but not in browser.',
        ownershipChoices: '- [x] Handler / transport',
        productObjective: 'Browser correctness remains a release promise.',
        responsivenessRisk: 'browser-specific proof could be overstated by a node-only lane.',
        stateAndControlChoices: '- [x] What is blocked and why',
        targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Browser proof run must name a browser lane or browser-specific proof.',
    );
  });

  it('rejects fake browser proof commands that only share a command prefix', () => {
    const fakeBrowserProofCommands = [
      'npm run test:browserish',
      'npm run test:browser-nope',
      'npm run test:browser:nonexistent',
      'npm run test:browser:terminal:nope',
      'npm run test:browser:e2e:update',
      'npm run profile:terminal:fake',
      'npx playwrightish',
      'playwright tester',
    ];

    for (const browserProofRun of fakeBrowserProofCommands) {
      const result = runValidator(
        createPullRequestBody({
          browserProofRun,
          browserSkipReason: 'none',
          evidence: 'browser-specific proof wording must name an executable proof.',
          frustration: 'It works in Electron but not in browser.',
          ownershipChoices: '- [x] Handler / transport',
          productObjective: 'Browser correctness remains a release promise.',
          responsivenessRisk: 'browser-specific proof could be overstated by a fake command.',
          stateAndControlChoices: '- [x] What is blocked and why',
          targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
        }),
      );

      expect(result.status, browserProofRun).toBe(1);
      expect(result.stderr).toContain(
        'Browser proof run must name a browser lane or browser-specific proof.',
      );
    }
  });

  it('rejects prose that only mentions a browser proof indicator', () => {
    const result = runValidator(
      createPullRequestBody({
        browserProofRun: 'the browser canary docs look good',
        browserSkipReason: 'none',
        evidence: 'browser-specific proof wording must name an executable proof.',
        frustration: 'It works in Electron but not in browser.',
        ownershipChoices: '- [x] Handler / transport',
        productObjective: 'Browser correctness remains a release promise.',
        responsivenessRisk: 'browser-specific proof could be overstated by prose.',
        stateAndControlChoices: '- [x] What is blocked and why',
        targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Browser proof run must name a browser lane or browser-specific proof.',
    );
  });

  it('rejects browser proof runs combined with a specific skipped-lane reason', () => {
    const result = runValidator(
      createPullRequestBody({
        browserProofRun: 'npm run test:browser:canaries',
        browserSkipReason:
          'no browser focus, paint, navigation, cookies, websocket auth, or multi-context path changed',
        evidence: 'browser canary covered reconnect visibility.',
        frustration: 'It works in Electron but not in browser.',
        ownershipChoices: '- [x] Handler / transport',
        productObjective: 'Browser correctness remains a release promise.',
        responsivenessRisk: 'browser-specific proof could contradict skipped-lane notes.',
        stateAndControlChoices: '- [x] What is blocked and why',
        targetedProof: 'npm run test:node:file -- src/runtime/browser-session.test.ts',
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Do not combine browser proof run with a skipped browser-lane reason.',
    );
  });

  it('rejects the checked-in template until placeholders are filled', () => {
    const result = runValidatorForFile('.github/PULL_REQUEST_TEMPLATE.md');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing field value: Frustration');
    expect(result.stderr).toContain('Missing field value: Product objective');
    expect(result.stderr).toContain('Missing field value: Browser lanes intentionally not run');
    expect(result.stderr).toContain('Select at least one ownership checkbox.');
    expect(result.stderr).toContain('Select at least one state/control checkbox.');
    expect(result.stderr).not.toContain(
      'Browser proof run must name a browser lane or browser-specific proof.',
    );
  });
});
