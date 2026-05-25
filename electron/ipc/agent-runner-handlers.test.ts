import { describe, expect, it } from 'vitest';

import { normalizeAgentRunnerProfileConfig } from './agent-runner-handlers.js';

describe('agent runner handler normalization', () => {
  it('normalizes Docker container runner profiles', () => {
    expect(
      normalizeAgentRunnerProfileConfig({
        dockerfile: 'docker/Dockerfile',
        env: { FOO: 'bar' },
        envAllowlist: ['OPENAI_API_KEY'],
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
      dockerfile: 'docker/Dockerfile',
      env: { FOO: 'bar' },
      envAllowlist: ['OPENAI_API_KEY'],
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

  it('rejects unknown providers', () => {
    expect(() => normalizeAgentRunnerProfileConfig({ provider: 'podman' })).toThrow(
      'agentRunnerProfile.provider must be "host", "docker-container", or "docker-sandbox"',
    );
  });

  it('rejects dockerfiles outside the project path', () => {
    expect(() =>
      normalizeAgentRunnerProfileConfig({
        dockerfile: '../Dockerfile',
        provider: 'docker-container',
      }),
    ).toThrow('agentRunnerProfile.dockerfile must not contain ".."');
  });

  it('rejects Docker container runners without an image or Dockerfile', () => {
    expect(() =>
      normalizeAgentRunnerProfileConfig({
        provider: 'docker-container',
      }),
    ).toThrow('agentRunnerProfile requires image or dockerfile for Docker container runners');
  });

  it('rejects blocked profile env names', () => {
    expect(() =>
      normalizeAgentRunnerProfileConfig({
        env: { PATH: '/tmp/injected' },
        image: 'agent:latest',
        provider: 'docker-container',
      }),
    ).toThrow('agentRunnerProfile.env.PATH is not allowed for agent runners');
  });

  it('rejects invalid profile env names', () => {
    expect(() =>
      normalizeAgentRunnerProfileConfig({
        env: { 'BAD-NAME': 'value' },
        image: 'agent:latest',
        provider: 'docker-container',
      }),
    ).toThrow('agentRunnerProfile.env.BAD-NAME must be a valid environment variable name');
  });

  it('rejects blocked env allowlist names', () => {
    expect(() =>
      normalizeAgentRunnerProfileConfig({
        envAllowlist: ['NODE_OPTIONS'],
        image: 'agent:latest',
        provider: 'docker-container',
      }),
    ).toThrow('agentRunnerProfile.envAllowlist[0] is not allowed for agent runners');
  });
});
