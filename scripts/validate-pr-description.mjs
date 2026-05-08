#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION = {
  productFrustration: 'Product Frustration',
  ownership: 'Ownership',
  stateAndControl: 'State And Control',
  validation: 'Validation',
  performanceAndResponsiveness: 'Performance And Responsiveness',
};

const FIELD = {
  frustration: 'Frustration',
  productObjective: 'Product objective',
  targetedProof: 'Targeted proof',
  broadProof: 'Broad proof',
  browserProofRun: 'Browser proof run',
  browserSkipReason: 'Browser lanes intentionally not run, with reason',
  responsivenessRisk: 'Responsiveness risk',
  evidence: 'Evidence',
};

const FIELD_SECTION = {
  [FIELD.frustration]: SECTION.productFrustration,
  [FIELD.productObjective]: SECTION.productFrustration,
  [FIELD.targetedProof]: SECTION.validation,
  [FIELD.broadProof]: SECTION.validation,
  [FIELD.browserProofRun]: SECTION.validation,
  [FIELD.browserSkipReason]: SECTION.validation,
  [FIELD.responsivenessRisk]: SECTION.performanceAndResponsiveness,
  [FIELD.evidence]: SECTION.performanceAndResponsiveness,
};

const REQUIRED_SECTIONS = Object.values(SECTION);
const REQUIRED_FIELDS = Object.values(FIELD);

const TEMPLATE_PLACEHOLDERS = new Set(['', '-', '?', 'todo', 'tbd']);
const GENERIC_FIELD_VALUES = new Set([
  ...TEMPLATE_PLACEHOLDERS,
  'n/a',
  'na',
  'no',
  'none',
  'not applicable',
  'not needed',
  'not required',
  'same as above',
  'see above',
]);
const STATE_NOT_APPLICABLE_LABEL = 'Not applicable';
const AMBIGUOUS_SKIPPED_BROWSER_PROOF_VALUES = new Set([
  'n/a',
  'na',
  'none',
  'not needed',
  'not required',
  'not run',
  'not applicable',
]);
const SKIPPED_BROWSER_PROOF_PREFIXES = ['not run:'];
const AMBIGUOUS_SKIPPED_BROWSER_PROOF_PREFIXES = [
  'did not run',
  'not run -',
  'not applicable:',
  'not applicable -',
];
const GENERIC_BROWSER_SKIP_REASONS = new Set([
  '',
  'because not needed',
  'because not required',
  'no',
  'no browser tests',
  'not applicable',
  ...AMBIGUOUS_SKIPPED_BROWSER_PROOF_VALUES,
]);
const BROWSER_PROOF_NPM_SCRIPT_PREFIXES = ['profile:terminal:', 'test:browser:'];
const BROWSER_PROOF_NPM_SCRIPT_EXCLUSIONS = new Set(['test:browser:e2e:update']);
const BROWSER_PROOF_DIRECT_COMMAND_PATTERNS = [
  /^npx playwright test(?:\s|$)/u,
  /^playwright test(?:\s|$)/u,
];
const BROWSER_MANUAL_PROOF_PREFIXES = [
  'browser canary:',
  'browser lab:',
  'browser manual:',
  'browser-lab:',
  'manual browser:',
];
const OWNERSHIP_DOCS_TOOLING_ONLY_LABEL = 'Docs / tooling only';
export const OWNERSHIP_LABELS = new Set([
  'Backend / external truth',
  'Handler / transport',
  'Workflow / app',
  'Store / projection',
  'Presentation',
  OWNERSHIP_DOCS_TOOLING_ONLY_LABEL,
]);
const MIN_BROWSER_MANUAL_PROOF_WORDS = 5;
const MIN_BROWSER_SKIP_REASON_WORDS = 5;
export const STATE_AND_CONTROL_LABELS = new Set([
  'Who controls the task or terminal',
  'What is running',
  'What is exposed',
  'What changed',
  'What is stale',
  'What needs attention',
  'What is blocked and why',
  STATE_NOT_APPLICABLE_LABEL,
]);

let packageScriptsCache = null;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBodyFromArgs(argv, env) {
  const fileIndex = argv.indexOf('--file');
  if (fileIndex !== -1) {
    const filePath = argv[fileIndex + 1];
    if (!filePath) {
      throw new Error('Expected a file path after --file');
    }

    return readFileSync(path.resolve(process.cwd(), filePath), 'utf8');
  }

  return env.PR_BODY ?? '';
}

function hasSection(body, section) {
  return new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'mu').test(body);
}

function getFieldValue(body, field) {
  const pattern = new RegExp(`^\\s*-\\s+${escapeRegExp(field)}:[^\\S\\r\\n]*(.*)$`, 'imu');
  const match = pattern.exec(body);
  return match?.[1]?.trim() ?? '';
}

function normalizeFieldValue(value) {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function countWords(value) {
  return value.match(/[a-z0-9]+/giu)?.length ?? 0;
}

function isMeaningfulFieldValue(field, value) {
  const normalizedValue = normalizeFieldValue(value);
  if (field === FIELD.browserProofRun || field === FIELD.browserSkipReason) {
    return !TEMPLATE_PLACEHOLDERS.has(normalizedValue);
  }

  return !GENERIC_FIELD_VALUES.has(normalizedValue);
}

function isBrowserProofSkipped(value) {
  const normalizedValue = normalizeFieldValue(value);

  return SKIPPED_BROWSER_PROOF_PREFIXES.some((prefix) => normalizedValue.startsWith(prefix));
}

function isAmbiguousSkippedBrowserProof(value) {
  const normalizedValue = normalizeFieldValue(value);

  return (
    AMBIGUOUS_SKIPPED_BROWSER_PROOF_VALUES.has(normalizedValue) ||
    AMBIGUOUS_SKIPPED_BROWSER_PROOF_PREFIXES.some((prefix) => normalizedValue.startsWith(prefix)) ||
    normalizedValue.startsWith('no ')
  );
}

function isMeaningfulBrowserSkipReason(value) {
  const normalizedValue = normalizeFieldValue(value);
  if (GENERIC_BROWSER_SKIP_REASONS.has(normalizedValue)) {
    return false;
  }

  if (normalizedValue.includes('not needed') || normalizedValue.includes('not required')) {
    return false;
  }

  return countWords(normalizedValue) >= MIN_BROWSER_SKIP_REASON_WORDS;
}

function getNpmRunScriptName(value) {
  const match = /^(?:[a-z_][a-z0-9_]*=\S+\s+)*npm run ([^\s]+)(?:\s|$)/u.exec(value);
  return match?.[1] ?? null;
}

function getPackageScripts() {
  if (packageScriptsCache) {
    return packageScriptsCache;
  }

  const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  const scripts = packageJson?.scripts;
  packageScriptsCache = scripts && typeof scripts === 'object' ? scripts : {};
  return packageScriptsCache;
}

function isBrowserProofNpmScript(scriptName) {
  if (BROWSER_PROOF_NPM_SCRIPT_EXCLUSIONS.has(scriptName)) {
    return false;
  }

  if (!BROWSER_PROOF_NPM_SCRIPT_PREFIXES.some((prefix) => scriptName.startsWith(prefix))) {
    return false;
  }

  return typeof getPackageScripts()[scriptName] === 'string';
}

function isSpecificBrowserProofRun(value) {
  const normalizedValue = normalizeFieldValue(value);
  const npmRunScriptName = getNpmRunScriptName(normalizedValue);
  if (npmRunScriptName) {
    return isBrowserProofNpmScript(npmRunScriptName);
  }

  if (BROWSER_PROOF_DIRECT_COMMAND_PATTERNS.some((pattern) => pattern.test(normalizedValue))) {
    return true;
  }

  if (BROWSER_MANUAL_PROOF_PREFIXES.some((prefix) => normalizedValue.startsWith(prefix))) {
    return countWords(normalizedValue) >= MIN_BROWSER_MANUAL_PROOF_WORDS;
  }

  return false;
}

function getSectionBody(body, section) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'mu');
  const match = pattern.exec(body);
  if (!match) {
    return '';
  }

  const bodyStartIndex = match.index + match[0].length;
  const remainingBody = body.slice(bodyStartIndex);
  const nextSectionIndex = remainingBody.search(/^##\s+/mu);
  if (nextSectionIndex === -1) {
    return remainingBody;
  }

  return remainingBody.slice(0, nextSectionIndex);
}

function getCheckedBoxLabels(body, section) {
  const labels = [];
  const sectionBody = getSectionBody(body, section);
  const checkedBoxPattern = /^-\s+\[[xX]\]\s+(.+)$/gmu;
  let match = checkedBoxPattern.exec(sectionBody);
  while (match !== null) {
    const label = match[1]?.trim();
    if (label) {
      labels.push(label);
    }
    match = checkedBoxPattern.exec(sectionBody);
  }

  return labels;
}

function getSectionFieldValue(body, field) {
  return getFieldValue(getSectionBody(body, FIELD_SECTION[field]), field);
}

function validateCheckboxSelections(body, options) {
  const { allowedLabels, errors, missingMessage, section, unknownMessagePrefix } = options;
  const selections = getCheckedBoxLabels(body, section);
  if (selections.length === 0) {
    errors.push(missingMessage);
  }

  for (const selection of selections) {
    if (!allowedLabels.has(selection)) {
      errors.push(`${unknownMessagePrefix}: ${selection}`);
    }
  }

  return selections;
}

export function validatePullRequestDescription(body) {
  const errors = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!hasSection(body, section)) {
      errors.push(`Missing section: ${section}`);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    const value = getSectionFieldValue(body, field);
    if (!isMeaningfulFieldValue(field, value)) {
      errors.push(`Missing field value: ${field}`);
    }
  }

  const ownershipSelections = validateCheckboxSelections(body, {
    allowedLabels: OWNERSHIP_LABELS,
    errors,
    missingMessage: 'Select at least one ownership checkbox.',
    section: SECTION.ownership,
    unknownMessagePrefix: 'Unknown ownership checkbox',
  });
  if (
    ownershipSelections.includes(OWNERSHIP_DOCS_TOOLING_ONLY_LABEL) &&
    ownershipSelections.length > 1
  ) {
    errors.push('Do not combine Docs / tooling only with runtime ownership checkboxes.');
  }

  const stateAndControlSelections = validateCheckboxSelections(body, {
    allowedLabels: STATE_AND_CONTROL_LABELS,
    errors,
    missingMessage: 'Select at least one state/control checkbox.',
    section: SECTION.stateAndControl,
    unknownMessagePrefix: 'Unknown state/control checkbox',
  });

  if (
    ownershipSelections.includes(OWNERSHIP_DOCS_TOOLING_ONLY_LABEL) &&
    !stateAndControlSelections.includes(STATE_NOT_APPLICABLE_LABEL)
  ) {
    errors.push('Docs / tooling only changes should mark state/control as Not applicable.');
  }

  if (
    stateAndControlSelections.includes(STATE_NOT_APPLICABLE_LABEL) &&
    stateAndControlSelections.length > 1
  ) {
    errors.push('Do not combine Not applicable with other state/control checkboxes.');
  }

  const browserProofRun = getSectionFieldValue(body, FIELD.browserProofRun);
  const browserSkipReason = getSectionFieldValue(body, FIELD.browserSkipReason);
  if (isMeaningfulFieldValue(FIELD.browserProofRun, browserProofRun)) {
    const browserProofWasSkipped = isBrowserProofSkipped(browserProofRun);
    const browserProofSkipIsAmbiguous = isAmbiguousSkippedBrowserProof(browserProofRun);
    if (browserProofSkipIsAmbiguous) {
      errors.push('Skipped browser proof must start with `not run:`.');
    }
    if (browserProofWasSkipped && !isMeaningfulBrowserSkipReason(browserSkipReason)) {
      errors.push('Explain why browser lanes were intentionally not run.');
    }
    if (
      !browserProofWasSkipped &&
      !browserProofSkipIsAmbiguous &&
      !isSpecificBrowserProofRun(browserProofRun)
    ) {
      errors.push('Browser proof run must name a browser lane or browser-specific proof.');
    }
    if (
      !browserProofWasSkipped &&
      !browserProofSkipIsAmbiguous &&
      isMeaningfulBrowserSkipReason(browserSkipReason)
    ) {
      errors.push('Do not combine browser proof run with a skipped browser-lane reason.');
    }
  }

  return errors;
}

function main() {
  const body = getBodyFromArgs(process.argv.slice(2), process.env);
  const errors = validatePullRequestDescription(body);
  if (errors.length === 0) {
    console.log('PR description includes required product validation fields.');
    return;
  }

  console.error('PR description is missing required product validation details:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main();
}
