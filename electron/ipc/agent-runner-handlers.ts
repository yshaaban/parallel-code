import { BadRequestError } from './errors.js';
import { validateRelativePath } from './path-utils.js';
import { assertOptionalString, assertString } from './validate.js';
import {
  isAllowedAgentRunnerEnvName,
  isAgentRunnerProvider,
  isValidAgentRunnerEnvName,
  type AgentRunnerMountConfig,
  type AgentRunnerNetworkConfig,
  type AgentRunnerProfileConfig,
  type AgentRunnerResourceConfig,
} from '../../src/domain/agent-runners.js';
import { isRecord } from '../../src/lib/type-guards.js';

function normalizeStringRecord(
  value: unknown,
  fieldName: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError(`${fieldName} must be an object`);
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    assertAgentRunnerEnvNameAllowed(key, `${fieldName}.${key}`);
    assertString(entry, `${fieldName}.${key}`);
    normalized[key] = entry;
  }
  return normalized;
}

function normalizeStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new BadRequestError(`${fieldName} must be an array`);
  }

  return value.map((entry, index) => {
    assertString(entry, `${fieldName}[${index}]`);
    assertAgentRunnerEnvNameAllowed(entry, `${fieldName}[${index}]`);
    return entry;
  });
}

function assertAgentRunnerEnvNameAllowed(value: string, fieldName: string): void {
  if (!isValidAgentRunnerEnvName(value)) {
    throw new BadRequestError(`${fieldName} must be a valid environment variable name`);
  }

  if (!isAllowedAgentRunnerEnvName(value)) {
    throw new BadRequestError(`${fieldName} is not allowed for agent runners`);
  }
}

function normalizeMounts(value: unknown): AgentRunnerMountConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new BadRequestError('agentRunnerProfile.mounts must be an array');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new BadRequestError(`agentRunnerProfile.mounts[${index}] must be an object`);
    }

    assertString(entry.source, `agentRunnerProfile.mounts[${index}].source`);
    assertString(entry.target, `agentRunnerProfile.mounts[${index}].target`);
    if (entry.readonly !== undefined && typeof entry.readonly !== 'boolean') {
      throw new BadRequestError(`agentRunnerProfile.mounts[${index}].readonly must be a boolean`);
    }

    return {
      ...(entry.readonly !== undefined ? { readonly: entry.readonly } : {}),
      source: entry.source,
      target: entry.target,
    };
  });
}

function normalizeResources(value: unknown): AgentRunnerResourceConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError('agentRunnerProfile.resources must be an object');
  }

  assertOptionalString(value.cpus, 'agentRunnerProfile.resources.cpus');
  assertOptionalString(value.memory, 'agentRunnerProfile.resources.memory');
  return {
    ...(value.cpus !== undefined ? { cpus: value.cpus } : {}),
    ...(value.memory !== undefined ? { memory: value.memory } : {}),
  };
}

function normalizeNetwork(value: unknown): AgentRunnerNetworkConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError('agentRunnerProfile.network must be an object');
  }

  if (
    value.mode !== undefined &&
    value.mode !== 'bridge' &&
    value.mode !== 'none' &&
    value.mode !== 'host'
  ) {
    throw new BadRequestError('agentRunnerProfile.network.mode must be bridge, none, or host');
  }

  return {
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  };
}

export function normalizeAgentRunnerProfileConfig(
  value: unknown,
): AgentRunnerProfileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new BadRequestError('agentRunnerProfile must be an object');
  }

  if (!isAgentRunnerProvider(value.provider)) {
    throw new BadRequestError(
      'agentRunnerProfile.provider must be "host", "docker-container", or "docker-sandbox"',
    );
  }

  assertOptionalString(value.image, 'agentRunnerProfile.image');
  assertOptionalString(value.dockerfile, 'agentRunnerProfile.dockerfile');
  assertOptionalString(value.workdir, 'agentRunnerProfile.workdir');
  assertOptionalString(value.workspaceMountTarget, 'agentRunnerProfile.workspaceMountTarget');
  assertOptionalString(value.user, 'agentRunnerProfile.user');
  if (value.dockerfile !== undefined) {
    validateRelativePath(value.dockerfile, 'agentRunnerProfile.dockerfile');
  }
  if (
    value.provider === 'docker-container' &&
    value.image === undefined &&
    value.dockerfile === undefined
  ) {
    throw new BadRequestError(
      'agentRunnerProfile requires image or dockerfile for Docker container runners',
    );
  }

  const env = normalizeStringRecord(value.env, 'agentRunnerProfile.env');
  const envAllowlist = normalizeStringArray(value.envAllowlist, 'agentRunnerProfile.envAllowlist');
  const mounts = normalizeMounts(value.mounts);
  const network = normalizeNetwork(value.network);
  const resources = normalizeResources(value.resources);

  return {
    ...(value.dockerfile !== undefined ? { dockerfile: value.dockerfile } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(envAllowlist !== undefined ? { envAllowlist } : {}),
    ...(value.image !== undefined ? { image: value.image } : {}),
    ...(mounts !== undefined ? { mounts } : {}),
    ...(network !== undefined ? { network } : {}),
    provider: value.provider,
    ...(resources !== undefined ? { resources } : {}),
    ...(value.user !== undefined ? { user: value.user } : {}),
    ...(value.workdir !== undefined ? { workdir: value.workdir } : {}),
    ...(value.workspaceMountTarget !== undefined
      ? { workspaceMountTarget: value.workspaceMountTarget }
      : {}),
  };
}
