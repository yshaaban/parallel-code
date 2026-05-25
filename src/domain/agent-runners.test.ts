import { describe, expect, it } from 'vitest';

import {
  createHostAgentRunnerResolution,
  isAgentRunnerProvider,
  parseAgentRunnerProfileConfig,
  resolveAgentRunnerProfile,
} from './agent-runners.js';

describe('agent runner domain', () => {
  it('defaults to host runner when no profile is configured', () => {
    expect(createHostAgentRunnerResolution()).toEqual({
      activeProvider: 'host',
      configuredProfile: null,
      message: 'No agent runner is configured; agents run on the host.',
      source: 'default',
      status: 'not_configured',
    });
  });

  it('resolves project runner config as canonical project config', () => {
    expect(
      resolveAgentRunnerProfile({
        image: 'parallel-code-agent:latest',
        provider: 'docker-container',
      }),
    ).toEqual({
      activeProvider: 'docker-container',
      configuredProfile: {
        image: 'parallel-code-agent:latest',
        provider: 'docker-container',
      },
      message: null,
      source: 'project-config',
      status: 'resolved',
    });
  });

  it('maps legacy task-container Docker runner profile into Docker container execution', () => {
    expect(
      resolveAgentRunnerProfile(undefined, {
        runnerProfile: {
          dockerfile: 'docker/Dockerfile',
          image: 'agent:latest',
          kind: 'docker',
        },
      }),
    ).toEqual({
      activeProvider: 'docker-container',
      configuredProfile: {
        dockerfile: 'docker/Dockerfile',
        image: 'agent:latest',
        provider: 'docker-container',
      },
      message:
        'Using the legacy Docker runner profile from the task-container configuration for agent execution.',
      source: 'legacy-container-config',
      status: 'resolved',
    });
  });

  it('marks Docker container runner profiles without an image or Dockerfile unsupported', () => {
    expect(
      resolveAgentRunnerProfile({
        provider: 'docker-container',
      }),
    ).toEqual({
      activeProvider: 'docker-container',
      configuredProfile: {
        provider: 'docker-container',
      },
      message: 'Docker container agent runners require an image or Dockerfile.',
      source: 'project-config',
      status: 'unsupported',
    });
  });

  it('marks Docker sandbox runner profiles unsupported with an explicit message', () => {
    expect(
      resolveAgentRunnerProfile({
        provider: 'docker-sandbox',
      }),
    ).toEqual({
      activeProvider: 'docker-sandbox',
      configuredProfile: {
        provider: 'docker-sandbox',
      },
      message:
        'Docker sandbox agent runners are reserved for a future provider and are not supported by this build.',
      source: 'project-config',
      status: 'unsupported',
    });
  });

  it('recognizes only known providers', () => {
    expect(isAgentRunnerProvider('host')).toBe(true);
    expect(isAgentRunnerProvider('docker-container')).toBe(true);
    expect(isAgentRunnerProvider('docker-sandbox')).toBe(true);
    expect(isAgentRunnerProvider('podman')).toBe(false);
  });

  it('parses persisted runner profile config with validated provider and field shapes', () => {
    expect(
      parseAgentRunnerProfileConfig({
        dockerfile: 'Dockerfile',
        env: { OPENAI_API_KEY: 'value' },
        envAllowlist: ['GITHUB_TOKEN'],
        image: 'agent:latest',
        mounts: [{ readonly: true, source: '/tmp/docs', target: '/docs' }],
        network: { mode: 'none' },
        provider: 'docker-container',
        resources: { cpus: '2', memory: '4g' },
        user: '1000:1000',
        workdir: '/workspace',
        workspaceMountTarget: '/workspace',
      }),
    ).toEqual({
      dockerfile: 'Dockerfile',
      env: { OPENAI_API_KEY: 'value' },
      envAllowlist: ['GITHUB_TOKEN'],
      image: 'agent:latest',
      mounts: [{ readonly: true, source: '/tmp/docs', target: '/docs' }],
      network: { mode: 'none' },
      provider: 'docker-container',
      resources: { cpus: '2', memory: '4g' },
      user: '1000:1000',
      workdir: '/workspace',
      workspaceMountTarget: '/workspace',
    });
  });

  it('drops invalid persisted runner profile config instead of resolving unknown providers', () => {
    expect(parseAgentRunnerProfileConfig({ image: 'agent:latest', provider: 'podman' })).toBe(
      undefined,
    );
    expect(
      parseAgentRunnerProfileConfig({
        image: 'agent:latest',
        network: { mode: 'private-lan' },
        provider: 'docker-container',
      }),
    ).toBe(undefined);
  });
});
