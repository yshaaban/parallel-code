import {
  deriveResumeFallbackOperationId,
  type AgentSessionOperationResult,
} from '../../src/domain/agent-session-operation.js';
import type { AgentDef } from '../../src/ipc/types.js';
import {
  classifyAgentResumeFallback,
  createBoundedAgentResumeExitFacts,
  type AgentResumeExitFacts,
  type ResumeFallbackDecision,
} from '../../src/lib/agent-resume.js';
import type { AgentSessionWorkflow } from './agent-session-workflow.js';

export interface FinalizedAgentSessionExit extends AgentResumeExitFacts {
  agentId: string;
  generation: number;
  taskId: string;
}

type AuthoritativeFinalizedAgentSessionExit = Omit<FinalizedAgentSessionExit, 'lastOutput'>;

export interface AuthoritativeAgentSessionRecoveryContext {
  agentDef: Pick<AgentDef, 'id' | 'resume_failure_classifier' | 'resume_failure_fallback'>;
  currentGeneration: number;
  trust: 'built-in-catalog';
}

export interface AgentSessionRecoveryLease {
  leaseGeneration: number;
  release(): Promise<void> | void;
}

export interface AgentSessionRecoveryDependencies {
  acquireSystemLease(
    exit: Readonly<AuthoritativeFinalizedAgentSessionExit>,
  ): AgentSessionRecoveryLease | null | Promise<AgentSessionRecoveryLease | null>;
  resolveAuthoritativeExit(
    exit: Readonly<AuthoritativeFinalizedAgentSessionExit>,
  ):
    | AuthoritativeAgentSessionRecoveryContext
    | null
    | Promise<AuthoritativeAgentSessionRecoveryContext | null>;
  workflow: Pick<AgentSessionWorkflow, 'execute'>;
}

export type AgentSessionRecoveryResult =
  | {
      decision: ResumeFallbackDecision & { kind: 'ineligible' };
      kind: 'ineligible';
    }
  | {
      kind: 'operation';
      operationId: string;
      result: Extract<AgentSessionOperationResult, { kind: 'operation' }>;
    }
  | { kind: 'unavailable' };

export const AGENT_SESSION_RECOVERY_CONTROLLER_ID = 'system:agent-session-recovery-v1';

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !value.includes('\u0000')
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isAuthoritativeContext(
  value: AuthoritativeAgentSessionRecoveryContext | null,
  exit: AuthoritativeFinalizedAgentSessionExit,
): value is AuthoritativeAgentSessionRecoveryContext {
  return (
    value !== null &&
    value.trust === 'built-in-catalog' &&
    isIdentity(value.agentDef.id) &&
    isGeneration(value.currentGeneration) &&
    value.currentGeneration === exit.generation &&
    (value.agentDef.resume_failure_classifier === undefined ||
      value.agentDef.resume_failure_classifier === 'claude-no-conversation-v1') &&
    (value.agentDef.resume_failure_fallback === undefined ||
      value.agentDef.resume_failure_fallback === 'fresh-start' ||
      value.agentDef.resume_failure_fallback === 'none')
  );
}

function isFinalizedExit(value: FinalizedAgentSessionExit): boolean {
  return (
    isIdentity(value.taskId) &&
    isIdentity(value.agentId) &&
    isGeneration(value.generation) &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    (value.signal === null || typeof value.signal === 'string') &&
    typeof value.resumed === 'boolean' &&
    Array.isArray(value.lastOutput)
  );
}

export interface AgentSessionRecoveryAdapter {
  handleFinalizedExit(exit: FinalizedAgentSessionExit): Promise<AgentSessionRecoveryResult>;
}

class AgentSessionRecoveryAdapterImpl implements AgentSessionRecoveryAdapter {
  constructor(private readonly dependencies: AgentSessionRecoveryDependencies) {}

  async handleFinalizedExit(exit: FinalizedAgentSessionExit): Promise<AgentSessionRecoveryResult> {
    if (!isFinalizedExit(exit)) return { kind: 'unavailable' };
    const boundedFacts = createBoundedAgentResumeExitFacts(exit);
    const stableExit: AuthoritativeFinalizedAgentSessionExit = {
      agentId: exit.agentId,
      exitCode: boundedFacts.exitCode,
      generation: exit.generation,
      resumed: boundedFacts.resumed,
      signal: boundedFacts.signal,
      taskId: exit.taskId,
    };
    let context: AuthoritativeAgentSessionRecoveryContext | null;
    try {
      context = await this.dependencies.resolveAuthoritativeExit(stableExit);
    } catch {
      return { kind: 'unavailable' };
    }
    if (!isAuthoritativeContext(context, stableExit)) return { kind: 'unavailable' };

    const decision = classifyAgentResumeFallback(context.agentDef, boundedFacts);
    if (decision.kind === 'ineligible') return { decision, kind: 'ineligible' };

    let operationId: string;
    try {
      operationId = deriveResumeFallbackOperationId(
        stableExit.taskId,
        stableExit.agentId,
        stableExit.generation,
      );
    } catch {
      return { kind: 'unavailable' };
    }
    let lease: AgentSessionRecoveryLease | null;
    try {
      lease = await this.dependencies.acquireSystemLease(stableExit);
    } catch {
      return { kind: 'unavailable' };
    }
    if (!lease || !isGeneration(lease.leaseGeneration)) return { kind: 'unavailable' };
    try {
      let result: AgentSessionOperationResult;
      try {
        result = await this.dependencies.workflow.execute({
          admission: { kind: 'resume-fallback-system' },
          agentId: stableExit.agentId,
          controllerId: AGENT_SESSION_RECOVERY_CONTROLLER_ID,
          expectedLeaseGeneration: lease.leaseGeneration,
          expectedSourceGeneration: stableExit.generation,
          launchReason: 'resume-fallback',
          mode: 'fresh',
          operationId,
          taskId: stableExit.taskId,
        });
      } catch {
        return { kind: 'unavailable' };
      }
      return result.kind === 'operation'
        ? { kind: 'operation', operationId, result }
        : { kind: 'unavailable' };
    } finally {
      try {
        await lease.release();
      } catch {
        // The exact lease expires independently. Recovery outcome remains
        // authoritative even when best-effort early release is unavailable.
      }
    }
  }
}

export function createAgentSessionRecoveryAdapter(
  dependencies: AgentSessionRecoveryDependencies,
): AgentSessionRecoveryAdapter {
  return new AgentSessionRecoveryAdapterImpl(dependencies);
}
