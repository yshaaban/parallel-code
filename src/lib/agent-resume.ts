import type { AgentDef, AgentResumeFailureClassifier, AgentResumeStrategy } from '../ipc/types.js';
import { isHydraAgentDef } from './hydra.js';
import { getVisibleTerminalTextForDetection } from './prompt-detection.js';
import { isStringMember } from './type-guards.js';

type AgentResumeArgSource = Pick<AgentDef, 'adapter' | 'id' | 'resume_strategy'> & {
  args?: unknown;
  resume_args?: unknown;
  skip_permissions_args?: unknown;
};

const AGENT_RESUME_STRATEGY_VALUES = {
  'cli-args': true,
  'hydra-session': true,
  none: true,
} satisfies Record<AgentResumeStrategy, true>;

export const AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES = 16 * 1_024;
export const AGENT_RESUME_FAILURE_OUTPUT_MAX_LINES = 50;

const AGENT_RESUME_FAILURE_FRAME_MAX_LINES = 5;
const CLAUDE_NO_CONVERSATION_LINE = 'No conversation found to continue';
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const UTF8_NEWLINE = UTF8_ENCODER.encode('\n');

export interface AgentResumeExitFacts {
  exitCode: number | null;
  lastOutput: readonly string[];
  resumed: boolean;
  signal: string | null;
}

export type ResumeFallbackDecision =
  | { classifier: AgentResumeFailureClassifier; kind: 'eligible' }
  | {
      kind: 'ineligible';
      reason:
        | 'no-match'
        | 'not-resumed'
        | 'signal'
        | 'spawn-failed'
        | 'successful-exit'
        | 'unsupported';
    };

type AgentResumeFailureCapabilitySource = Pick<
  AgentDef,
  'resume_failure_classifier' | 'resume_failure_fallback'
>;

function getBoundedOutputTail(lastOutput: readonly string[]): string {
  const selected: Uint8Array[] = [];
  let retainedBytes = 0;
  for (let index = lastOutput.length - 1; index >= 0; index -= 1) {
    if (index < lastOutput.length - 1) {
      const separatorBytes = Math.min(
        UTF8_NEWLINE.byteLength,
        AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES - retainedBytes,
      );
      if (separatorBytes > 0) {
        selected.push(UTF8_NEWLINE.subarray(UTF8_NEWLINE.byteLength - separatorBytes));
        retainedBytes += separatorBytes;
      }
    }

    const remaining = AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES - retainedBytes;
    if (remaining <= 0) {
      break;
    }
    const value = lastOutput[index];
    const boundedValue =
      typeof value === 'string' ? value.slice(-AGENT_RESUME_FAILURE_OUTPUT_MAX_BYTES) : '';
    const encoded = UTF8_ENCODER.encode(boundedValue);
    if (encoded.byteLength <= remaining) {
      selected.push(encoded);
      retainedBytes += encoded.byteLength;
      continue;
    }
    selected.push(encoded.slice(encoded.byteLength - remaining));
    retainedBytes += remaining;
    break;
  }

  selected.reverse();
  const tail = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of selected) {
    tail.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return UTF8_DECODER.decode(tail);
}

export function createBoundedAgentResumeExitFacts(
  facts: AgentResumeExitFacts,
): AgentResumeExitFacts {
  return {
    exitCode: facts.exitCode,
    lastOutput: [getBoundedOutputTail(facts.lastOutput)],
    resumed: facts.resumed,
    signal: facts.signal,
  };
}

function getBoundedVisibleOutputLines(lastOutput: readonly string[]): string[] {
  const visible = getVisibleTerminalTextForDetection(getBoundedOutputTail(lastOutput));
  return visible
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-AGENT_RESUME_FAILURE_OUTPUT_MAX_LINES);
}

function matchesResumeFailureClassifier(
  classifier: AgentResumeFailureClassifier,
  lastOutput: readonly string[],
): boolean {
  switch (classifier) {
    case 'claude-no-conversation-v1':
      return getBoundedVisibleOutputLines(lastOutput)
        .slice(-AGENT_RESUME_FAILURE_FRAME_MAX_LINES)
        .some((line) => line === CLAUDE_NO_CONVERSATION_LINE);
  }
}

export function classifyAgentResumeFallback(
  capability: AgentResumeFailureCapabilitySource,
  facts: AgentResumeExitFacts,
): ResumeFallbackDecision {
  if (!facts.resumed) {
    return { kind: 'ineligible', reason: 'not-resumed' };
  }
  if (facts.signal === 'spawn_failed') {
    return { kind: 'ineligible', reason: 'spawn-failed' };
  }
  if (facts.signal !== null) {
    return { kind: 'ineligible', reason: 'signal' };
  }
  if (facts.exitCode === 0) {
    return { kind: 'ineligible', reason: 'successful-exit' };
  }
  const classifier = capability.resume_failure_classifier;
  if (
    facts.exitCode === null ||
    classifier === undefined ||
    capability.resume_failure_fallback !== 'fresh-start'
  ) {
    return { kind: 'ineligible', reason: 'unsupported' };
  }
  return matchesResumeFailureClassifier(classifier, facts.lastOutput)
    ? { classifier, kind: 'eligible' }
    : { kind: 'ineligible', reason: 'no-match' };
}

function getAgentArgs(args: unknown): string[] {
  if (!Array.isArray(args)) {
    return [];
  }

  return args.filter((arg): arg is string => typeof arg === 'string');
}

export function isAgentResumeStrategy(value: unknown): value is AgentResumeStrategy {
  return isStringMember(value, AGENT_RESUME_STRATEGY_VALUES);
}

export function getAgentResumeStrategy(agentDef: AgentResumeArgSource): AgentResumeStrategy {
  if (isAgentResumeStrategy(agentDef.resume_strategy)) {
    return agentDef.resume_strategy;
  }

  if (isHydraAgentDef(agentDef)) {
    return 'hydra-session';
  }

  return getAgentArgs(agentDef.resume_args).length > 0 ? 'cli-args' : 'none';
}

export function buildAgentSpawnArgs(
  agentDef: AgentResumeArgSource,
  options: {
    resumed: boolean;
    skipPermissions: boolean;
  },
): string[] {
  const resumeStrategy = getAgentResumeStrategy(agentDef);
  const baseArgs =
    options.resumed && resumeStrategy === 'cli-args'
      ? getAgentArgs(agentDef.resume_args)
      : getAgentArgs(agentDef.args);
  const skipPermissionArgs = options.skipPermissions
    ? getAgentArgs(agentDef.skip_permissions_args)
    : [];

  const mergedArgs = [...baseArgs];
  for (const arg of skipPermissionArgs) {
    if (!mergedArgs.includes(arg)) {
      mergedArgs.push(arg);
    }
  }

  return mergedArgs;
}

export function shouldResumeAgentOnSpawn(
  agentDef: AgentResumeArgSource,
  resumed: boolean,
): boolean {
  const resumeStrategy = getAgentResumeStrategy(agentDef);
  return resumed && resumeStrategy === 'hydra-session';
}
