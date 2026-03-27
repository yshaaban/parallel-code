function getRequiredNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

function getRequiredMax(values) {
  if (values.length === 0) {
    return Number.NaN;
  }

  return Math.max(...values.map((value) => getRequiredNumber(value)));
}

function getReconnectMaxReconnectMs(result) {
  return getRequiredMax(
    (result.phases.reconnectOutputBursts ?? []).map((burst) => burst.reconnectMs),
  );
}

function getReconnectMaxSkewMs(result) {
  return getRequiredMax(
    (result.phases.reconnectOutputBursts ?? []).map((burst) => burst.metrics?.maxSkewMs),
  );
}

function getReconnectBackpressureRejects(result) {
  return (result.phases.reconnectOutputBursts ?? []).reduce((total, burst) => {
    return total + getRequiredNumber(burst.diagnostics?.browserControl?.backpressureRejects);
  }, 0);
}

function getLateJoinBatchRequests(result) {
  return getRequiredNumber(result.phases.lateJoin?.replay?.requestCount);
}

function getLateJoinReturnedBytes(result) {
  return getRequiredNumber(result.phases.lateJoin?.replay?.totalReturnedBytes);
}

function getLateJoinReplayDuration(result) {
  return getRequiredNumber(result.phases.lateJoin?.replay?.wallClockMs);
}

function getLateJoinMaxReadyMs(result) {
  return getRequiredNumber(result.phases.lateJoin?.lateJoinClients?.maxReadyMs);
}

function getLateJoinExistingImpactMaxSkewMs(result) {
  return getRequiredNumber(result.phases.lateJoin?.existingClientImpact?.maxSkewMs);
}

function getSlowLinkBackpressureRejects(result) {
  return (
    getRequiredNumber(result.phases.input?.diagnostics?.browserControl?.backpressureRejects) +
    getRequiredNumber(result.phases.mixed?.diagnostics?.browserControl?.backpressureRejects)
  );
}

function createMaxBudget(label, max, measure) {
  return {
    label,
    max,
    measure,
  };
}

function createMinBudget(label, min, measure) {
  return {
    label,
    min,
    measure,
  };
}

function getPhaseWallClock(result, phaseName) {
  return getRequiredNumber(result.phases?.[phaseName]?.wallClockMs);
}

function getMaxPhaseMetric(result, phaseNames, getValue) {
  return getRequiredMax(
    phaseNames.map((phaseName) => {
      return getValue(result.phases?.[phaseName] ?? null);
    }),
  );
}

function getTotalPhaseMetric(result, phaseNames, getValue) {
  return phaseNames.reduce((total, phaseName) => {
    return total + getValue(result.phases?.[phaseName] ?? null);
  }, 0);
}

function getVerboseMaxSkew(result, phaseNames) {
  return getMaxPhaseMetric(result, phaseNames, (phase) =>
    getRequiredNumber(phase?.metrics?.maxSkewMs),
  );
}

function getVerboseBrowserControlRejects(result, phaseNames) {
  return getTotalPhaseMetric(result, phaseNames, (phase) => {
    return getRequiredNumber(phase?.diagnostics?.browserControl?.backpressureRejects);
  });
}

function getVerboseDegradedChannels(result, phaseNames) {
  return getMaxPhaseMetric(result, phaseNames, (phase) => {
    return getRequiredNumber(phase?.diagnostics?.browserChannels?.degradedClientChannels);
  });
}

function getVerboseQueuedChars(result, phaseNames) {
  return getMaxPhaseMetric(result, phaseNames, (phase) => {
    return getRequiredNumber(phase?.diagnostics?.ptyInput?.maxQueuedChars);
  });
}

function createVerboseBurstProfile(style, description) {
  return {
    args: {
      bulkTextLineBytes: 6144,
      bulkTextLines: 24,
      inputChunks: 0,
      lateJoiners: 0,
      lines: 0,
      mixedLines: 0,
      outputWorkloadStyle: style,
      reconnects: 0,
      redrawFrames: 0,
      terminals: 24,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('output wall clock', 25_000, (result) => getPhaseWallClock(result, 'output')),
      createMaxBudget('output max skew', 2_000, (result) => {
        return getRequiredNumber(result.phases.output?.metrics?.maxSkewMs);
      }),
      createMaxBudget('output degraded channels', 0, (result) => {
        return getRequiredNumber(
          result.phases.output?.diagnostics?.browserChannels?.degradedClientChannels,
        );
      }),
    ],
    description,
  };
}

const SLOW_LINK_ARGS = {
  inputChunkBytes: 4096,
  inputChunks: 24,
  jitterMs: 20,
  lateJoiners: 0,
  latencyMs: 40,
  lines: 40,
  mixedLineBytes: 4096,
  mixedLines: 20,
  outputLineBytes: 4096,
  packetLoss: 0.02,
  reconnects: 1,
  terminals: 12,
  users: 6,
  warmScrollbackLines: 0,
};

const SLOW_LINK_BUDGETS = [
  createMaxBudget('input wall clock', 30_000, (result) =>
    getRequiredNumber(result.phases.input?.wallClockMs),
  ),
  createMaxBudget('slow-link mixed max skew', 2_500, (result) => {
    return getRequiredNumber(result.phases.mixed?.metrics?.maxSkewMs);
  }),
  createMaxBudget('slow-link backpressure rejects', 5_000, getSlowLinkBackpressureRejects),
];

function createSlowLinkVariantProfile(description, overrides) {
  return {
    args: {
      ...SLOW_LINK_ARGS,
      ...overrides,
    },
    budgets: SLOW_LINK_BUDGETS,
    description,
  };
}

export const SESSION_STRESS_PROFILES = {
  pr_smoke: {
    args: {
      inputChunkBytes: 2048,
      inputChunks: 6,
      lines: 20,
      mixedLineBytes: 2048,
      mixedLines: 8,
      outputLineBytes: 1024,
      reconnects: 1,
      terminals: 6,
      users: 3,
    },
    budgets: [
      createMaxBudget('output wall clock', 5_000, (result) =>
        getRequiredNumber(result.phases.output?.wallClockMs),
      ),
      createMaxBudget('mixed max skew', 1_000, (result) =>
        getRequiredNumber(result.phases.mixed?.metrics?.maxSkewMs),
      ),
      createMaxBudget('output backpressure rejects', 0, (result) =>
        getRequiredNumber(result.phases.output?.diagnostics?.browserControl?.backpressureRejects),
      ),
    ],
    description: 'Fast shared-session smoke profile for PR and local confidence checks.',
  },
  steady_fanout: {
    args: {
      inputChunks: 0,
      lateJoiners: 0,
      lines: 60,
      mixedLines: 0,
      reconnects: 0,
      terminals: 12,
      users: 4,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('output wall clock', 5_000, (result) =>
        getRequiredNumber(result.phases.output?.wallClockMs),
      ),
      createMaxBudget('output max skew', 750, (result) =>
        getRequiredNumber(result.phases.output?.metrics?.maxSkewMs),
      ),
      createMaxBudget('output degraded channels', 0, (result) =>
        getRequiredNumber(
          result.phases.output?.diagnostics?.browserChannels?.degradedClientChannels,
        ),
      ),
    ],
    description: 'Steady hot-session fanout without reconnect, replay, or heavy input.',
  },
  heavy_tui: {
    args: {
      inputChunkBytes: 4096,
      inputChunks: 24,
      lateJoiners: 0,
      lines: 40,
      mixedLineBytes: 4096,
      mixedLines: 20,
      outputLineBytes: 4096,
      reconnects: 1,
      terminals: 12,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('input wall clock', 20_000, (result) =>
        getRequiredNumber(result.phases.input?.wallClockMs),
      ),
      createMaxBudget('mixed max skew', 1_250, (result) =>
        getRequiredNumber(result.phases.mixed?.metrics?.maxSkewMs),
      ),
      createMaxBudget('mixed queued chars', 262_144, (result) =>
        getRequiredNumber(result.phases.mixed?.diagnostics?.ptyInput?.maxQueuedChars),
      ),
    ],
    description: 'Heavy TUI-style output and input on a hot shared session.',
  },
  verbose_bulk_text: {
    args: {
      bulkTextLineBytes: 6144,
      bulkTextLines: 24,
      inputChunks: 0,
      lateJoiners: 0,
      lines: 0,
      mixedLines: 0,
      outputWorkloadStyle: 'bulk-text',
      reconnects: 0,
      redrawFrames: 0,
      terminals: 24,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('output wall clock', 25_000, (result) => getPhaseWallClock(result, 'output')),
      createMaxBudget('output max skew', 2_000, (result) => {
        return getRequiredNumber(result.phases.output?.metrics?.maxSkewMs);
      }),
      createMaxBudget('output degraded channels', 0, (result) => {
        return getRequiredNumber(
          result.phases.output?.diagnostics?.browserChannels?.degradedClientChannels,
        );
      }),
    ],
    description:
      '24-terminal steady-state bulk-text workload that isolates paragraph-heavy agent output.',
  },
  verbose_markdown_burst: createVerboseBurstProfile(
    'markdown-burst',
    '24-terminal steady-state markdown-heavy verbose workload that isolates wrapped prose, lists, and fenced blocks.',
  ),
  verbose_code_burst: createVerboseBurstProfile(
    'code-burst',
    '24-terminal steady-state code-heavy verbose workload that isolates long wrapped code blocks and identifier churn.',
  ),
  verbose_diff_burst: createVerboseBurstProfile(
    'diff-burst',
    '24-terminal steady-state diff-heavy verbose workload that isolates patch-style output and hunk markers.',
  ),
  verbose_agent_cli_burst: createVerboseBurstProfile(
    'agent-cli-burst',
    '24-terminal steady-state agent-cli verbose workload that isolates command/status narration and progress-style bursts.',
  ),
  verbose_statusline: {
    args: {
      inputChunks: 0,
      lateJoiners: 0,
      lines: 0,
      mixedLines: 0,
      outputWorkloadStyle: 'statusline',
      reconnects: 0,
      redrawChunkDelayMs: 1,
      redrawFooterTopRow: 20,
      redrawFrameDelayMs: 12,
      redrawFrames: 96,
      terminals: 24,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('output wall clock', 25_000, (result) => getPhaseWallClock(result, 'output')),
      createMaxBudget('output max skew', 2_000, (result) => {
        return getRequiredNumber(result.phases.output?.metrics?.maxSkewMs);
      }),
      createMaxBudget('output degraded channels', 0, (result) => {
        return getRequiredNumber(
          result.phases.output?.diagnostics?.browserChannels?.degradedClientChannels,
        );
      }),
    ],
    description:
      '24-terminal redraw-heavy statusline workload that isolates cursor-control and TUI-style output.',
  },
  verbose_mixed_agents: {
    args: {
      bulkTextLineBytes: 6144,
      bulkTextLines: 12,
      inputChunks: 0,
      lateJoiners: 0,
      lines: 0,
      mixedLines: 0,
      outputWorkloadStyle: 'mixed',
      reconnects: 0,
      redrawChunkDelayMs: 1,
      redrawFooterTopRow: 20,
      redrawFrameDelayMs: 12,
      redrawFrames: 48,
      terminals: 24,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('output wall clock', 25_000, (result) => getPhaseWallClock(result, 'output')),
      createMaxBudget('output max skew', 2_000, (result) => {
        return getRequiredNumber(result.phases.output?.metrics?.maxSkewMs);
      }),
      createMaxBudget('output degraded channels', 0, (result) => {
        return getRequiredNumber(
          result.phases.output?.diagnostics?.browserChannels?.degradedClientChannels,
        );
      }),
    ],
    description:
      '24-terminal mixed verbose workload combining bulk text and redraw-heavy statusline output in the same active stream.',
  },
  interactive_verbose: {
    args: {
      bulkTextLineBytes: 4096,
      bulkTextLines: 8,
      inputChunkBytes: 4096,
      inputChunks: 12,
      lateJoiners: 0,
      lines: 0,
      mixedLines: 0,
      mixedWorkloadStyle: 'mixed',
      outputWorkloadStyle: 'lines',
      reconnects: 0,
      redrawChunkDelayMs: 1,
      redrawFooterTopRow: 20,
      redrawFrameDelayMs: 12,
      redrawFrames: 32,
      terminals: 24,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('mixed wall clock', 20_000, (result) => getPhaseWallClock(result, 'mixed')),
      createMaxBudget('mixed max skew', 2_000, (result) => {
        return getRequiredNumber(result.phases.mixed?.metrics?.maxSkewMs);
      }),
      createMaxBudget('mixed queued chars', 262_144, (result) => {
        return getRequiredNumber(result.phases.mixed?.diagnostics?.ptyInput?.maxQueuedChars);
      }),
    ],
    description:
      '24-terminal interactive verbose workload with mixed redraw/text output under concurrent terminal input.',
  },
  steady_verbose_agents_24: {
    args: {
      bulkTextLineBytes: 6144,
      bulkTextLines: 24,
      inputChunkBytes: 4096,
      inputChunks: 12,
      lateJoiners: 0,
      lines: 0,
      mixedLineBytes: 4096,
      mixedLines: 16,
      outputLineBytes: 4096,
      redrawChunkDelayMs: 1,
      redrawFooterTopRow: 20,
      redrawFrameDelayMs: 12,
      redrawFrames: 96,
      reconnects: 0,
      terminals: 24,
      users: 6,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('input wall clock', 20_000, (result) => getPhaseWallClock(result, 'input')),
      createMaxBudget('bulk-text wall clock', 25_000, (result) =>
        getPhaseWallClock(result, 'bulkText'),
      ),
      createMaxBudget('redraw wall clock', 25_000, (result) => getPhaseWallClock(result, 'redraw')),
      createMaxBudget('mixed wall clock', 20_000, (result) => getPhaseWallClock(result, 'mixed')),
      createMaxBudget('verbose max skew', 2_000, (result) =>
        getVerboseMaxSkew(result, ['input', 'bulkText', 'redraw', 'mixed']),
      ),
      createMaxBudget('verbose browser-control rejects', 0, (result) =>
        getVerboseBrowserControlRejects(result, ['input', 'bulkText', 'redraw', 'mixed']),
      ),
      createMaxBudget('verbose degraded channels', 0, (result) =>
        getVerboseDegradedChannels(result, ['input', 'bulkText', 'redraw', 'mixed']),
      ),
      createMaxBudget('verbose queued chars', 131_072, (result) =>
        getVerboseQueuedChars(result, ['input', 'bulkText', 'redraw', 'mixed']),
      ),
    ],
    description:
      '24-terminal steady-state verbose-agent workload with bulk text, redraw-heavy statuslines, and mixed agent behavior.',
  },
  reconnect_storm: {
    args: {
      inputChunks: 0,
      lateJoiners: 0,
      lines: 40,
      mixedLines: 0,
      reconnects: 3,
      terminals: 12,
      users: 4,
      warmScrollbackLines: 0,
    },
    budgets: [
      createMaxBudget('max reconnect time', 5_000, getReconnectMaxReconnectMs),
      createMaxBudget('max reconnect skew', 1_500, getReconnectMaxSkewMs),
      createMaxBudget('reconnect backpressure rejects', 0, getReconnectBackpressureRejects),
    ],
    description: 'Reconnect waves against a hot session with output bursts after each restore.',
  },
  late_join: {
    args: {
      inputChunks: 0,
      lateJoinLiveLineBytes: 2048,
      lateJoinLiveLines: 12,
      lateJoiners: 2,
      lines: 0,
      mixedLines: 0,
      reconnects: 0,
      terminals: 12,
      users: 4,
      warmScrollbackLineBytes: 4096,
      warmScrollbackLines: 120,
    },
    budgets: [
      createMaxBudget('late join replay duration', 5_000, getLateJoinReplayDuration),
      createMaxBudget('late join ready time', 5_000, getLateJoinMaxReadyMs),
      createMaxBudget('late join existing-client skew', 1_250, getLateJoinExistingImpactMaxSkewMs),
      createMaxBudget('late join batch requests', 2, getLateJoinBatchRequests),
      createMinBudget('late join returned bytes', 1, getLateJoinReturnedBytes),
    ],
    description: 'Fresh users binding to a hot session with warm scrollback and live output.',
  },
  late_join_public: {
    args: {
      inputChunks: 0,
      lateJoinLiveLineBytes: 2048,
      lateJoinLiveLines: 12,
      lateJoiners: 2,
      lines: 0,
      mixedLines: 0,
      reconnects: 0,
      terminals: 12,
      users: 4,
      warmScrollbackLineBytes: 4096,
      warmScrollbackLines: 120,
    },
    budgets: [
      createMaxBudget('late join replay duration', 10_000, getLateJoinReplayDuration),
      createMaxBudget('late join ready time', 10_000, getLateJoinMaxReadyMs),
      createMaxBudget('late join existing-client skew', 2_500, getLateJoinExistingImpactMaxSkewMs),
      createMaxBudget('late join batch requests', 2, getLateJoinBatchRequests),
      createMinBudget('late join returned bytes', 1, getLateJoinReturnedBytes),
    ],
    description:
      'Public-path late-join validation with WAN-tolerant readiness and existing-user impact budgets.',
  },
  slow_link: {
    args: SLOW_LINK_ARGS,
    budgets: SLOW_LINK_BUDGETS,
    description: 'Heavy shared-session load under latency, jitter, and retransmission-style loss.',
  },
  slow_link_drain_25_passes_2: createSlowLinkVariantProfile(
    'Slow-link tuning variant with a 25ms browser-channel drain interval and 2 degraded drain passes.',
    {
      browserChannelBackpressureDrainIntervalMs: 25,
      browserChannelClientDegradedMaxDrainPasses: 2,
    },
  ),
  slow_link_drain_25_passes_6: createSlowLinkVariantProfile(
    'Slow-link tuning variant with a 25ms browser-channel drain interval and 6 degraded drain passes.',
    {
      browserChannelBackpressureDrainIntervalMs: 25,
      browserChannelClientDegradedMaxDrainPasses: 6,
    },
  ),
  slow_link_drain_50_passes_2: createSlowLinkVariantProfile(
    'Slow-link tuning variant with a 50ms browser-channel drain interval and 2 degraded drain passes.',
    {
      browserChannelBackpressureDrainIntervalMs: 50,
      browserChannelClientDegradedMaxDrainPasses: 2,
    },
  ),
  slow_link_drain_50_passes_4: createSlowLinkVariantProfile(
    'Slow-link tuning variant with a 50ms browser-channel drain interval and 4 degraded drain passes.',
    {
      browserChannelBackpressureDrainIntervalMs: 50,
      browserChannelClientDegradedMaxDrainPasses: 4,
    },
  ),
  slow_link_drain_50_passes_6: createSlowLinkVariantProfile(
    'Slow-link tuning variant with a 50ms browser-channel drain interval and 6 degraded drain passes.',
    {
      browserChannelBackpressureDrainIntervalMs: 50,
      browserChannelClientDegradedMaxDrainPasses: 6,
    },
  ),
};

export const SESSION_STRESS_MATRICES = {
  production: [
    'steady_fanout',
    'steady_verbose_agents_24',
    'heavy_tui',
    'reconnect_storm',
    'late_join',
    'slow_link',
  ],
  production_public: [
    'steady_fanout',
    'steady_verbose_agents_24',
    'heavy_tui',
    'reconnect_storm',
    'late_join_public',
    'slow_link',
  ],
  steady_state_verbose: [
    'steady_fanout',
    'verbose_bulk_text',
    'verbose_markdown_burst',
    'verbose_code_burst',
    'verbose_diff_burst',
    'verbose_agent_cli_burst',
    'verbose_statusline',
    'verbose_mixed_agents',
    'interactive_verbose',
    'steady_verbose_agents_24',
  ],
  slow_link_tuning: [
    'slow_link_drain_25_passes_2',
    'slow_link_drain_25_passes_6',
    'slow_link_drain_50_passes_2',
    'slow_link_drain_50_passes_4',
    'slow_link_drain_50_passes_6',
  ],
  smoke: ['pr_smoke'],
};

export function getSessionStressProfile(name) {
  const profile = SESSION_STRESS_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown session stress profile: ${name}`);
  }

  return profile;
}

export function getSessionStressProfileNames() {
  return Object.keys(SESSION_STRESS_PROFILES);
}

export function getSessionStressMatrixNames() {
  return Object.keys(SESSION_STRESS_MATRICES);
}

export function getSessionStressMatrix(name) {
  const profileNames = SESSION_STRESS_MATRICES[name];
  if (!profileNames) {
    throw new Error(`Unknown session stress matrix: ${name}`);
  }

  return [...profileNames];
}

export function mergeSessionStressOptions(profileArgs, overrideArgs) {
  return {
    ...profileArgs,
    ...overrideArgs,
  };
}

export function evaluateSessionStressProfile(profileName, result) {
  const profile = getSessionStressProfile(profileName);
  const checks = profile.budgets.map((budget) => {
    const actual = budget.measure(result);
    const isFiniteActual = Number.isFinite(actual);
    const tooHigh = isFiniteActual && budget.max !== undefined && actual > budget.max;
    const tooLow = isFiniteActual && budget.min !== undefined && actual < budget.min;
    return {
      actual,
      label: budget.label,
      max: budget.max ?? null,
      min: budget.min ?? null,
      pass: isFiniteActual && !tooHigh && !tooLow,
    };
  });

  return {
    pass: checks.every((check) => check.pass),
    profileName,
    checks,
  };
}
