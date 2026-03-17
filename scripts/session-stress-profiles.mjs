function getReconnectMaxReconnectMs(result) {
  return Math.max(
    0,
    ...(result.phases.reconnectOutputBursts ?? []).map((burst) => burst.reconnectMs ?? 0),
  );
}

function getReconnectMaxSkewMs(result) {
  return Math.max(
    0,
    ...(result.phases.reconnectOutputBursts ?? []).map((burst) => burst.metrics?.maxSkewMs ?? 0),
  );
}

function getReconnectBackpressureRejects(result) {
  return (result.phases.reconnectOutputBursts ?? []).reduce((total, burst) => {
    return total + (burst.diagnostics?.browserControl?.backpressureRejects ?? 0);
  }, 0);
}

function getLateJoinBatchRequests(result) {
  return result.phases.lateJoin?.diagnostics?.scrollbackReplay?.batchRequests ?? 0;
}

function getLateJoinReturnedBytes(result) {
  return result.phases.lateJoin?.replay?.totalReturnedBytes ?? 0;
}

function getSlowLinkBackpressureRejects(result) {
  return (
    (result.phases.input?.diagnostics?.browserControl?.backpressureRejects ?? 0) +
    (result.phases.mixed?.diagnostics?.browserControl?.backpressureRejects ?? 0)
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
  createMaxBudget('input wall clock', 30_000, (result) => result.phases.input?.wallClockMs ?? 0),
  createMaxBudget('slow-link mixed max skew', 2_500, (result) => {
    return result.phases.mixed?.metrics?.maxSkewMs ?? 0;
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
      createMaxBudget(
        'output wall clock',
        5_000,
        (result) => result.phases.output?.wallClockMs ?? 0,
      ),
      createMaxBudget(
        'mixed max skew',
        1_000,
        (result) => result.phases.mixed?.metrics?.maxSkewMs ?? 0,
      ),
      createMaxBudget(
        'output backpressure rejects',
        0,
        (result) => result.phases.output?.diagnostics?.browserControl?.backpressureRejects ?? 0,
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
      createMaxBudget(
        'output wall clock',
        5_000,
        (result) => result.phases.output?.wallClockMs ?? 0,
      ),
      createMaxBudget(
        'output max skew',
        750,
        (result) => result.phases.output?.metrics?.maxSkewMs ?? 0,
      ),
      createMaxBudget(
        'output degraded channels',
        0,
        (result) => result.phases.output?.diagnostics?.browserChannels?.degradedClientChannels ?? 0,
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
      createMaxBudget(
        'input wall clock',
        20_000,
        (result) => result.phases.input?.wallClockMs ?? 0,
      ),
      createMaxBudget(
        'mixed max skew',
        1_250,
        (result) => result.phases.mixed?.metrics?.maxSkewMs ?? 0,
      ),
      createMaxBudget(
        'mixed queued chars',
        262_144,
        (result) => result.phases.mixed?.diagnostics?.ptyInput?.maxQueuedChars ?? 0,
      ),
    ],
    description: 'Heavy TUI-style output and input on a hot shared session.',
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
      createMaxBudget(
        'late join replay duration',
        5_000,
        (result) => result.phases.lateJoin?.replay?.wallClockMs ?? 0,
      ),
      createMaxBudget(
        'late join max skew',
        1_250,
        (result) => result.phases.lateJoin?.metrics?.maxSkewMs ?? 0,
      ),
      createMaxBudget('late join batch requests', 2, getLateJoinBatchRequests),
      createMinBudget('late join returned bytes', 1, getLateJoinReturnedBytes),
    ],
    description: 'Fresh users binding to a hot session with warm scrollback and live output.',
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
  production: ['steady_fanout', 'heavy_tui', 'reconnect_storm', 'late_join', 'slow_link'],
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
    const tooHigh = budget.max !== undefined && actual > budget.max;
    const tooLow = budget.min !== undefined && actual < budget.min;
    return {
      actual,
      label: budget.label,
      max: budget.max ?? null,
      min: budget.min ?? null,
      pass: !tooHigh && !tooLow,
    };
  });

  return {
    pass: checks.every((check) => check.pass),
    profileName,
    checks,
  };
}
