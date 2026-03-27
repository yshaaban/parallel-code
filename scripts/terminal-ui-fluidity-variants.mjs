const PREEMPTION_DISABLED_EXPERIMENTS = Object.freeze({
  focusedPreemptionDrainScope: 'all',
  focusedPreemptionWindowMs: 0,
});

const BACKGROUND_BUDGET_OVERRIDES = Object.freeze({
  'active-visible': 48 * 1024,
  focused: 96 * 1024,
  hidden: 2 * 1024,
  'visible-background': 8 * 1024,
});

const CANDIDATE_LIMITED_NON_FOCUSED_OVERRIDES = Object.freeze({
  'active-visible': 2,
  hidden: 1,
  'visible-background': 1,
});

const WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  'active-visible': 16 * 1024,
  focused: 32 * 1024,
  hidden: 8 * 1024,
  'visible-background': 8 * 1024,
});

const WRITE_BATCH_LIMIT_OVERRIDES_16K = Object.freeze({
  'active-visible': 16 * 1024,
  focused: 16 * 1024,
  hidden: 8 * 1024,
  'visible-background': 16 * 1024,
});

const WRITE_BATCH_LIMIT_OVERRIDES_32K = Object.freeze({
  'active-visible': 32 * 1024,
  focused: 32 * 1024,
  hidden: 8 * 1024,
  'visible-background': 16 * 1024,
});

const WRITE_BATCH_LIMIT_OVERRIDES_64K = Object.freeze({
  'active-visible': 64 * 1024,
  focused: 64 * 1024,
  hidden: 8 * 1024,
  'visible-background': 32 * 1024,
});

const VISIBILITY_AWARE_CANDIDATE_LIMIT_OVERRIDES = Object.freeze({
  dense: Object.freeze({
    'active-visible': 1,
    hidden: 1,
    'visible-background': 1,
  }),
  few: Object.freeze({
    'active-visible': 2,
    hidden: 1,
    'visible-background': 1,
  }),
});

const VISIBILITY_AWARE_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  dense: Object.freeze({
    'active-visible': 12 * 1024,
    focused: 24 * 1024,
    hidden: 8 * 1024,
    'visible-background': 8 * 1024,
  }),
  few: Object.freeze({
    'active-visible': 16 * 1024,
    focused: 32 * 1024,
    hidden: 8 * 1024,
    'visible-background': 16 * 1024,
  }),
  single: Object.freeze({
    'active-visible': 32 * 1024,
    focused: 32 * 1024,
    hidden: 8 * 1024,
    'visible-background': 32 * 1024,
  }),
});

const SWITCH_TARGET_FRAME_SHAPED_CANDIDATE_LIMIT_OVERRIDES = Object.freeze({
  dense: Object.freeze({
    'active-visible': 1,
    hidden: 1,
    'visible-background': 1,
  }),
  few: Object.freeze({
    'active-visible': 1,
    hidden: 1,
    'visible-background': 1,
  }),
});

const SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  dense: Object.freeze({
    'active-visible': 8 * 1024,
    focused: 24 * 1024,
    hidden: 8 * 1024,
    'switch-target-visible': 24 * 1024,
    'visible-background': 8 * 1024,
  }),
  few: Object.freeze({
    'active-visible': 12 * 1024,
    focused: 32 * 1024,
    hidden: 8 * 1024,
    'switch-target-visible': 32 * 1024,
    'visible-background': 8 * 1024,
  }),
  single: Object.freeze({
    'active-visible': 32 * 1024,
    focused: 32 * 1024,
    hidden: 8 * 1024,
    'switch-target-visible': 32 * 1024,
    'visible-background': 32 * 1024,
  }),
});

const FRAME_BUDGET_VISIBLE_BALANCED = Object.freeze({
  few: Object.freeze({
    visible: 64 * 1024,
  }),
  single: Object.freeze({
    visible: 96 * 1024,
  }),
});

const FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED = Object.freeze({
  few: Object.freeze({
    visible: 64 * 1024,
  }),
});

const FRAME_BUDGET_SWITCH_TARGET_MULTI_VISIBLE = Object.freeze({
  dense: Object.freeze({
    visible: 40 * 1024,
  }),
  few: Object.freeze({
    visible: 56 * 1024,
  }),
});

const SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET = Object.freeze({
  dense: 12 * 1024,
  few: 24 * 1024,
});

const SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET_TIGHT = Object.freeze({
  dense: 8 * 1024,
  few: 16 * 1024,
});

const SWITCH_TARGET_VISIBLE_RESERVE_BALANCED = Object.freeze({
  dense: 16 * 1024,
  few: 24 * 1024,
});

const SWITCH_TARGET_VISIBLE_RESERVE_TIGHT = Object.freeze({
  dense: 24 * 1024,
  few: 32 * 1024,
});

const MULTI_VISIBLE_DENSE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES = Object.freeze({
  critical: 0.25,
  elevated: 0.5,
});

const MULTI_VISIBLE_DENSE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES_TIGHT = Object.freeze({
  critical: 0.125,
  elevated: 0.375,
});

const MULTI_VISIBLE_DENSE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES = Object.freeze({
  'visible-background': Object.freeze({
    critical: 0.25,
    elevated: 0.5,
  }),
});

const MULTI_VISIBLE_DENSE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES_TIGHT =
  Object.freeze({
    'visible-background': Object.freeze({
      critical: 0.125,
      elevated: 0.375,
    }),
  });

const FRAME_BUDGET_VISIBLE_TIGHT = Object.freeze({
  dense: Object.freeze({
    visible: 32 * 1024,
  }),
  few: Object.freeze({
    visible: 48 * 1024,
  }),
  single: Object.freeze({
    visible: 64 * 1024,
  }),
});

const SHAPE_SPLIT_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES = Object.freeze({
  2: Object.freeze({
    visible: FRAME_BUDGET_SWITCH_TARGET_MULTI_VISIBLE.few.visible,
  }),
  4: Object.freeze({
    visible: FRAME_BUDGET_SWITCH_TARGET_MULTI_VISIBLE.few.visible,
  }),
});

const SHAPE_SPLIT_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES = Object.freeze({
  2: SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET_TIGHT.few,
  4: SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET_TIGHT.few,
});

const SHAPE_SPLIT_VISIBLE_COUNT_SWITCH_TARGET_RESERVE_BYTES = Object.freeze({
  2: SWITCH_TARGET_VISIBLE_RESERVE_BALANCED.few,
  4: SWITCH_TARGET_VISIBLE_RESERVE_BALANCED.few,
});

const SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  2: Object.freeze({
    ...SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES.few,
  }),
  4: Object.freeze({
    ...SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES.few,
  }),
});

const SHAPE_SPLIT_DENSE_FALLBACK_LANE_FRAME_BUDGET_OVERRIDES = Object.freeze({
  dense: Object.freeze({
    visible: FRAME_BUDGET_SWITCH_TARGET_MULTI_VISIBLE.dense.visible,
  }),
});

const SHAPE_SPLIT_DENSE_FALLBACK_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES = Object.freeze({
  dense: SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET_TIGHT.dense,
});

const SHAPE_SPLIT_DENSE_FALLBACK_SWITCH_TARGET_RESERVE_BYTES = Object.freeze({
  dense: SWITCH_TARGET_VISIBLE_RESERVE_BALANCED.dense,
});

const SHAPE_SPLIT_DENSE_FALLBACK_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  dense: Object.freeze({
    ...SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES.dense,
  }),
});

const SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES = Object.freeze({
  4: Object.freeze({
    focused: Object.freeze({
      critical: 1.5,
      elevated: 1.25,
    }),
  }),
});

const SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES = Object.freeze({
  4: Object.freeze({
    focused: Object.freeze({
      critical: 1.5,
      elevated: 1.25,
    }),
  }),
});

const SHAPE_SPLIT_SPARSE_VISIBLE_COUNT_DRAIN_BUDGET_OVERRIDES = Object.freeze({
  1: Object.freeze({
    focused: 128 * 1024,
  }),
});

const SHAPE_SPLIT_SPARSE_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  1: Object.freeze({
    focused: 64 * 1024,
    hidden: 8 * 1024,
    'switch-target-visible': 64 * 1024,
    'visible-background': 32 * 1024,
    'active-visible': 32 * 1024,
  }),
});

const SHAPE_SPLIT_SPARSE1_SWITCH_POST_INPUT_READY_ECHO_GRACE_MS = Object.freeze({
  1: 120,
});

const SHAPE_SPLIT_SPARSE1_SWITCH_FIRST_FOCUSED_WRITE_BATCH_LIMIT_BYTES = Object.freeze({
  1: 8 * 1024,
});

const VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_A_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES =
  Object.freeze({
    1: Object.freeze({
      visible: 96 * 1024,
    }),
    2: Object.freeze({
      visible: 64 * 1024,
    }),
    4: Object.freeze({
      visible: SHAPE_SPLIT_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES[4].visible,
    }),
  });

const VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_B_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES =
  Object.freeze({
    2: 24 * 1024,
    4: 12 * 1024,
  });

const VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_C_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES =
  Object.freeze({
    1: Object.freeze({
      'active-visible': 32 * 1024,
      focused: 32 * 1024,
      hidden: 8 * 1024,
      'switch-target-visible': 32 * 1024,
      'visible-background': 32 * 1024,
    }),
    2: Object.freeze({
      'active-visible': 16 * 1024,
      focused: 32 * 1024,
      hidden: 8 * 1024,
      'switch-target-visible': 32 * 1024,
      'visible-background': 16 * 1024,
    }),
    4: Object.freeze({
      ...SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES[4],
    }),
  });

const STRUCTURAL_HEAVY_LOAD_VISIBLE_COUNT_ADDITIONAL_LIVE_VISIBLE_LIMIT = Object.freeze({
  2: 0,
  4: 1,
});

const STRUCTURAL_HEAVY_LOAD_VISIBLE_COUNT_ADDITIONAL_LIVE_VISIBLE_LIMIT_TIGHT = Object.freeze({
  2: 0,
  4: 0,
});

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES = Object.freeze({
  4: SHAPE_SPLIT_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES[4],
});

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES =
  Object.freeze({
    4: SHAPE_SPLIT_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES[4],
  });

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_SWITCH_TARGET_RESERVE_BYTES = Object.freeze({
  4: SHAPE_SPLIT_VISIBLE_COUNT_SWITCH_TARGET_RESERVE_BYTES[4],
});

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  4: SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES[4],
});

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES = Object.freeze({
  4: SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES[4],
});

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES =
  Object.freeze({
    4: SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES[4],
  });

const GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_ADDITIONAL_LIVE_VISIBLE_LIMIT = Object.freeze({
  4: 1,
});

const SHORT_FOCUSED_PREEMPTION = Object.freeze({
  focusedPreemptionDrainScope: 'focused',
  focusedPreemptionWindowMs: 150,
});

const VISIBLE_FOCUSED_PREEMPTION = Object.freeze({
  focusedPreemptionDrainScope: 'visible',
  focusedPreemptionWindowMs: 250,
});

const SWITCH_TARGET_BASE_EXPERIMENTS = Object.freeze({
  ...SHORT_FOCUSED_PREEMPTION,
  adaptiveVisibleBackgroundMinimumVisibleCount: 2,
  adaptiveVisibleBackgroundThrottleMode: 'moderate',
  switchTargetWindowMs: 250,
});

const SWITCH_TARGET_HARD_CONTRACT_BASE_EXPERIMENTS = Object.freeze({
  ...SWITCH_TARGET_BASE_EXPERIMENTS,
  switchTargetProtectUntilInputReady: true,
});

const PRESSURE_DRIVEN_ACTIVE_VISIBLE_MODERATE = Object.freeze({
  adaptiveActiveVisibleMinimumVisibleCount: 2,
  adaptiveActiveVisibleThrottleMode: 'moderate',
});

const PRESSURE_DRIVEN_ACTIVE_VISIBLE_AGGRESSIVE = Object.freeze({
  adaptiveActiveVisibleMinimumVisibleCount: 2,
  adaptiveActiveVisibleThrottleMode: 'aggressive',
});

const TIERED_HIDDEN_LIFECYCLE = Object.freeze({
  ...PREEMPTION_DISABLED_EXPERIMENTS,
  hiddenTerminalHibernationDelayMs: 900,
  hiddenTerminalSessionDormancyDelayMs: 2_400,
});

function createVariant(label, experiments = {}, options = {}) {
  return Object.freeze({
    injectExperiments: options.injectExperiments !== false,
    injectHighLoadMode: options.injectHighLoadMode === true,
    experiments: Object.freeze({
      ...experiments,
      label,
    }),
    highLoadModeEnabled: options.highLoadModeEnabled === true,
    label,
  });
}

function createHighLoadModeProductVariant(label) {
  return createVariant(
    label,
    {},
    {
      highLoadModeEnabled: true,
      injectExperiments: false,
      injectHighLoadMode: true,
    },
  );
}

function createVisibilityAwareOutputPacingVariant(label, extraExperiments = {}) {
  return createVariant(
    label,
    {
      ...SHORT_FOCUSED_PREEMPTION,
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
      multiVisiblePressureMinimumVisibleCount: 4,
      multiVisiblePressureNonTargetVisibleFrameBudgetScales:
        MULTI_VISIBLE_DENSE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES_TIGHT,
      multiVisiblePressureWriteBatchLimitScales:
        MULTI_VISIBLE_DENSE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES_TIGHT,
      switchTargetWindowMs: 250,
      visibleCountLaneFrameBudgetOverrides: SHAPE_SPLIT_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES,
      visibleCountNonTargetVisibleFrameBudgetOverrides:
        SHAPE_SPLIT_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
      visibleCountPressureDrainBudgetScales:
        SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
      visibleCountPressureWriteBatchLimitScales:
        SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
      visibleCountSwitchTargetReserveBytes: SHAPE_SPLIT_VISIBLE_COUNT_SWITCH_TARGET_RESERVE_BYTES,
      visibleCountWriteBatchLimitOverrides: SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
      visibilityAwareLaneFrameBudgetOverrides:
        SHAPE_SPLIT_DENSE_FALLBACK_LANE_FRAME_BUDGET_OVERRIDES,
      visibilityAwareNonTargetVisibleFrameBudgetOverrides:
        SHAPE_SPLIT_DENSE_FALLBACK_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
      visibilityAwareSwitchTargetReserveBytes:
        SHAPE_SPLIT_DENSE_FALLBACK_SWITCH_TARGET_RESERVE_BYTES,
      visibilityAwareWriteBatchLimitOverrides:
        SHAPE_SPLIT_DENSE_FALLBACK_WRITE_BATCH_LIMIT_OVERRIDES,
      ...extraExperiments,
    },
    {
      highLoadModeEnabled: true,
      injectHighLoadMode: true,
    },
  );
}

function createSwitchTargetVisibleReserveVariant(label, reserveOverrides) {
  return createVariant(label, {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
    visibilityAwareSwitchTargetReserveBytes: reserveOverrides,
  });
}

function createSwitchTargetVisibleReserveFrameShapedVariant(label, reserveOverrides) {
  return createVariant(label, {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
    visibilityAwareSwitchTargetReserveBytes: reserveOverrides,
    visibilityAwareWriteBatchLimitOverrides: SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES,
  });
}

function createMultiVisibleReserveSharedTightFrameShapedVariant(label, extraExperiments = {}) {
  return createVariant(label, {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    ...extraExperiments,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_SWITCH_TARGET_MULTI_VISIBLE,
    visibilityAwareNonTargetVisibleFrameBudgetOverrides:
      SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET_TIGHT,
    visibilityAwareSwitchTargetReserveBytes: SWITCH_TARGET_VISIBLE_RESERVE_BALANCED,
    visibilityAwareWriteBatchLimitOverrides: SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES,
  });
}

function createMultiVisibleReserveSharedTightFrameShapedDensePressureVariant(
  label,
  extraExperiments = {},
) {
  return createMultiVisibleReserveSharedTightFrameShapedVariant(label, {
    multiVisiblePressureMinimumVisibleCount: 4,
    ...extraExperiments,
  });
}

function createShapeSplitVisibleBudgetDensePressureVariant(label, extraExperiments = {}) {
  return createVariant(label, {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    multiVisiblePressureMinimumVisibleCount: 4,
    multiVisiblePressureNonTargetVisibleFrameBudgetScales:
      MULTI_VISIBLE_DENSE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES_TIGHT,
    multiVisiblePressureWriteBatchLimitScales:
      MULTI_VISIBLE_DENSE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES_TIGHT,
    visibleCountLaneFrameBudgetOverrides: SHAPE_SPLIT_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES,
    visibleCountNonTargetVisibleFrameBudgetOverrides:
      SHAPE_SPLIT_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
    visibleCountSwitchTargetReserveBytes: SHAPE_SPLIT_VISIBLE_COUNT_SWITCH_TARGET_RESERVE_BYTES,
    visibleCountWriteBatchLimitOverrides: SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
    visibilityAwareLaneFrameBudgetOverrides: SHAPE_SPLIT_DENSE_FALLBACK_LANE_FRAME_BUDGET_OVERRIDES,
    visibilityAwareNonTargetVisibleFrameBudgetOverrides:
      SHAPE_SPLIT_DENSE_FALLBACK_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
    visibilityAwareSwitchTargetReserveBytes: SHAPE_SPLIT_DENSE_FALLBACK_SWITCH_TARGET_RESERVE_BYTES,
    visibilityAwareWriteBatchLimitOverrides: SHAPE_SPLIT_DENSE_FALLBACK_WRITE_BATCH_LIMIT_OVERRIDES,
    ...extraExperiments,
  });
}

function createStructuralHeavyLoadVariant(label, additionalLiveVisibleLimit) {
  return createShapeSplitVisibleBudgetDensePressureVariant(label, {
    visibleCountAdditionalLiveVisibleLimit: additionalLiveVisibleLimit,
    visibleCountPressureDrainBudgetScales:
      SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
    visibleCountPressureWriteBatchLimitScales:
      SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
  });
}

function createGuardedDenseOverloadVariant(label, extraExperiments = {}) {
  return createVariant(
    label,
    {
      ...SHORT_FOCUSED_PREEMPTION,
      denseOverloadMinimumVisibleCount: 4,
      denseOverloadPressureFloor: 'elevated',
      denseOverloadVisibleCountLaneFrameBudgetOverrides:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES,
      denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
      denseOverloadVisibleCountSwitchTargetReserveBytes:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_SWITCH_TARGET_RESERVE_BYTES,
      denseOverloadVisibleCountWriteBatchLimitOverrides:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
      denseOverloadVisibleCountPressureDrainBudgetScales:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
      denseOverloadVisibleCountPressureWriteBatchLimitScales:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
      ...extraExperiments,
    },
    {
      highLoadModeEnabled: true,
      injectHighLoadMode: true,
    },
  );
}

const TERMINAL_UI_FLUIDITY_VARIANTS = Object.freeze({
  baseline: createVariant('baseline', PREEMPTION_DISABLED_EXPERIMENTS),
  product_default: createVariant(
    'product_default',
    {},
    {
      highLoadModeEnabled: false,
      injectExperiments: false,
      injectHighLoadMode: true,
    },
  ),
  hidden_hibernation: createVariant('hidden_hibernation', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    hiddenTerminalHibernationDelayMs: 900,
  }),
  render_freeze: createVariant('render_freeze', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    hiddenTerminalHibernationDelayMs: 900,
  }),
  render_freeze_preemption_150: createVariant('render_freeze_preemption_150', {
    ...SHORT_FOCUSED_PREEMPTION,
    hiddenTerminalHibernationDelayMs: 900,
  }),
  render_freeze_intent_prewarm: createVariant('render_freeze_intent_prewarm', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    hiddenTerminalHibernationDelayMs: 900,
    sidebarIntentPrewarmDelayMs: 120,
  }),
  live_surface_tiering_1: createVariant('live_surface_tiering_1', {
    ...SHORT_FOCUSED_PREEMPTION,
    hiddenTerminalHibernationDelayMs: 900,
    hiddenTerminalHotCount: 1,
  }),
  live_surface_tiering_2: createVariant('live_surface_tiering_2', {
    ...SHORT_FOCUSED_PREEMPTION,
    hiddenTerminalHibernationDelayMs: 900,
    hiddenTerminalHotCount: 2,
  }),
  live_surface_tiering_2_dormant_cold: createVariant('live_surface_tiering_2_dormant_cold', {
    ...SHORT_FOCUSED_PREEMPTION,
    hiddenTerminalHibernationDelayMs: 900,
    hiddenTerminalHotCount: 2,
    hiddenTerminalSessionDormancyDelayMs: 2_400,
  }),
  focused_preemption: createVariant('focused_preemption', {
    focusedPreemptionDrainScope: 'focused',
    focusedPreemptionWindowMs: 400,
  }),
  focused_preemption_150: createVariant('focused_preemption_150', SHORT_FOCUSED_PREEMPTION),
  focused_preemption_250: createVariant('focused_preemption_250', {
    focusedPreemptionDrainScope: 'focused',
    focusedPreemptionWindowMs: 250,
  }),
  focused_preemption_visible: createVariant(
    'focused_preemption_visible',
    VISIBLE_FOCUSED_PREEMPTION,
  ),
  focused_preemption_limited: createVariant('focused_preemption_limited', {
    ...SHORT_FOCUSED_PREEMPTION,
    drainCandidateLimitOverrides: CANDIDATE_LIMITED_NON_FOCUSED_OVERRIDES,
  }),
  frame_budgeted_visible_balanced: createVariant('frame_budgeted_visible_balanced', {
    ...SHORT_FOCUSED_PREEMPTION,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_BALANCED,
  }),
  frame_budgeted_visible_tight: createVariant('frame_budgeted_visible_tight', {
    ...SHORT_FOCUSED_PREEMPTION,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_TIGHT,
  }),
  adaptive_visible_background_moderate: createVariant('adaptive_visible_background_moderate', {
    ...SHORT_FOCUSED_PREEMPTION,
    adaptiveVisibleBackgroundThrottleMode: 'moderate',
  }),
  adaptive_visible_background_moderate_multi_visible: createVariant(
    'adaptive_visible_background_moderate_multi_visible',
    {
      ...SHORT_FOCUSED_PREEMPTION,
      adaptiveVisibleBackgroundMinimumVisibleCount: 2,
      adaptiveVisibleBackgroundThrottleMode: 'moderate',
    },
  ),
  adaptive_visible_background_aggressive: createVariant('adaptive_visible_background_aggressive', {
    ...SHORT_FOCUSED_PREEMPTION,
    adaptiveVisibleBackgroundThrottleMode: 'aggressive',
  }),
  frame_budgeted_adaptive_balanced: createVariant('frame_budgeted_adaptive_balanced', {
    ...SHORT_FOCUSED_PREEMPTION,
    adaptiveVisibleBackgroundThrottleMode: 'moderate',
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_BALANCED,
  }),
  frame_budgeted_adaptive_multi_visible: createVariant('frame_budgeted_adaptive_multi_visible', {
    ...SHORT_FOCUSED_PREEMPTION,
    adaptiveVisibleBackgroundMinimumVisibleCount: 2,
    adaptiveVisibleBackgroundThrottleMode: 'moderate',
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
  }),
  frame_budgeted_adaptive_multi_visible_switch: createVariant(
    'frame_budgeted_adaptive_multi_visible_switch',
    {
      ...SWITCH_TARGET_BASE_EXPERIMENTS,
      visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
    },
  ),
  switch_target_balanced: createVariant('switch_target_balanced', {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
  }),
  switch_target_balanced_pressure_yield: createVariant('switch_target_balanced_pressure_yield', {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    ...PRESSURE_DRIVEN_ACTIVE_VISIBLE_MODERATE,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
  }),
  switch_target_balanced_pressure_yield_aggressive: createVariant(
    'switch_target_balanced_pressure_yield_aggressive',
    {
      ...SWITCH_TARGET_BASE_EXPERIMENTS,
      ...PRESSURE_DRIVEN_ACTIVE_VISIBLE_AGGRESSIVE,
      visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
    },
  ),
  switch_target_frame_shaped: createVariant('switch_target_frame_shaped', {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    visibilityAwareDrainCandidateLimitOverrides:
      SWITCH_TARGET_FRAME_SHAPED_CANDIDATE_LIMIT_OVERRIDES,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_SWITCH_TARGET_MULTI_VISIBLE,
    visibilityAwareWriteBatchLimitOverrides: SWITCH_TARGET_FRAME_SHAPED_WRITE_BATCH_LIMIT_OVERRIDES,
  }),
  switch_target_non_target_capped: createVariant('switch_target_non_target_capped', {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    switchWindowNonTargetVisibleCandidateLimit: 1,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
  }),
  switch_target_shared_visible_budget: createVariant('switch_target_shared_visible_budget', {
    ...SWITCH_TARGET_BASE_EXPERIMENTS,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
    visibilityAwareNonTargetVisibleFrameBudgetOverrides: SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET,
  }),
  switch_target_shared_visible_budget_tight: createVariant(
    'switch_target_shared_visible_budget_tight',
    {
      ...SWITCH_TARGET_BASE_EXPERIMENTS,
      visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
      visibilityAwareNonTargetVisibleFrameBudgetOverrides:
        SWITCH_TARGET_SHARED_VISIBLE_FRAME_BUDGET_TIGHT,
    },
  ),
  switch_target_visible_reserve_balanced: createSwitchTargetVisibleReserveVariant(
    'switch_target_visible_reserve_balanced',
    SWITCH_TARGET_VISIBLE_RESERVE_BALANCED,
  ),
  switch_target_visible_reserve_tight: createSwitchTargetVisibleReserveVariant(
    'switch_target_visible_reserve_tight',
    SWITCH_TARGET_VISIBLE_RESERVE_TIGHT,
  ),
  switch_target_visible_reserve_frame_shaped_balanced:
    createSwitchTargetVisibleReserveFrameShapedVariant(
      'switch_target_visible_reserve_frame_shaped_balanced',
      SWITCH_TARGET_VISIBLE_RESERVE_BALANCED,
    ),
  switch_target_visible_reserve_frame_shaped_tight:
    createSwitchTargetVisibleReserveFrameShapedVariant(
      'switch_target_visible_reserve_frame_shaped_tight',
      SWITCH_TARGET_VISIBLE_RESERVE_TIGHT,
    ),
  multi_visible_reserve_shared_tight_frame_shaped:
    createMultiVisibleReserveSharedTightFrameShapedVariant(
      'multi_visible_reserve_shared_tight_frame_shaped',
    ),
  multi_visible_reserve_shared_tight_frame_shaped_active4_aggressive:
    createMultiVisibleReserveSharedTightFrameShapedVariant(
      'multi_visible_reserve_shared_tight_frame_shaped_active4_aggressive',
      {
        adaptiveActiveVisibleMinimumVisibleCount: 4,
        adaptiveActiveVisibleThrottleMode: 'aggressive',
      },
    ),
  multi_visible_reserve_shared_tight_frame_shaped_dense_pressure_visible_background:
    createMultiVisibleReserveSharedTightFrameShapedDensePressureVariant(
      'multi_visible_reserve_shared_tight_frame_shaped_dense_pressure_visible_background',
      {
        multiVisiblePressureNonTargetVisibleFrameBudgetScales:
          MULTI_VISIBLE_DENSE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES,
        multiVisiblePressureWriteBatchLimitScales:
          MULTI_VISIBLE_DENSE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES,
      },
    ),
  multi_visible_reserve_shared_tight_frame_shaped_dense_pressure_visible_background_tight:
    createMultiVisibleReserveSharedTightFrameShapedDensePressureVariant(
      'multi_visible_reserve_shared_tight_frame_shaped_dense_pressure_visible_background_tight',
      {
        multiVisiblePressureNonTargetVisibleFrameBudgetScales:
          MULTI_VISIBLE_DENSE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES_TIGHT,
        multiVisiblePressureWriteBatchLimitScales:
          MULTI_VISIBLE_DENSE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES_TIGHT,
      },
    ),
  shape_split_visible_budget_dense_pressure_reference:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_reference',
    ),
  shape_split_visible_budget_dense_pressure_interactive4:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_interactive4',
      {
        visibleCountDrainBudgetOverrides: {
          4: {
            focused: 128 * 1024,
          },
        },
        visibleCountWriteBatchLimitOverrides: {
          ...SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
          4: Object.freeze({
            ...SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES['4'],
            focused: 48 * 1024,
          }),
        },
      },
    ),
  shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled',
      {
        visibleCountPressureDrainBudgetScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
        visibleCountPressureWriteBatchLimitScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
      },
    ),
  shape_split_visible_budget_dense_pressure_sparse1_dense4_merged:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_sparse1_dense4_merged',
      {
        visibleCountDrainBudgetOverrides: {
          ...SHAPE_SPLIT_SPARSE_VISIBLE_COUNT_DRAIN_BUDGET_OVERRIDES,
        },
        visibleCountPressureDrainBudgetScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
        visibleCountPressureWriteBatchLimitScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
        visibleCountWriteBatchLimitOverrides: {
          ...SHAPE_SPLIT_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
          ...SHAPE_SPLIT_SPARSE_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
        },
      },
    ),
  shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse_switch_echo_grace:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse_switch_echo_grace',
      {
        visibleCountPressureDrainBudgetScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
        visibleCountPressureWriteBatchLimitScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
        visibleCountSwitchPostInputReadyEchoGraceMs: {
          1: 180,
          2: 180,
        },
      },
    ),
  shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse1_input_echo_grace:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse1_input_echo_grace',
      {
        visibleCountPressureDrainBudgetScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
        visibleCountPressureWriteBatchLimitScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
        visibleCountSwitchPostInputReadyEchoGraceMs:
          SHAPE_SPLIT_SPARSE1_SWITCH_POST_INPUT_READY_ECHO_GRACE_MS,
      },
    ),
  shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse1_input_echo_cap:
    createShapeSplitVisibleBudgetDensePressureVariant(
      'shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse1_input_echo_cap',
      {
        visibleCountPressureDrainBudgetScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_DRAIN_BUDGET_SCALES,
        visibleCountPressureWriteBatchLimitScales:
          SHAPE_SPLIT_INTERACTIVE_FOCUSED_PRESSURE_WRITE_BATCH_LIMIT_SCALES,
        visibleCountSwitchPostInputReadyEchoGraceMs:
          SHAPE_SPLIT_SPARSE1_SWITCH_POST_INPUT_READY_ECHO_GRACE_MS,
        visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes:
          SHAPE_SPLIT_SPARSE1_SWITCH_FIRST_FOCUSED_WRITE_BATCH_LIMIT_BYTES,
      },
    ),
  high_load_mode_product: createHighLoadModeProductVariant('high_load_mode_product'),
  high_load_mode_visibility_pacing_candidate_a: createVisibilityAwareOutputPacingVariant(
    'high_load_mode_visibility_pacing_candidate_a',
    {
      visibleCountLaneFrameBudgetOverrides:
        VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_A_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES,
    },
  ),
  high_load_mode_visibility_pacing_candidate_b: createVisibilityAwareOutputPacingVariant(
    'high_load_mode_visibility_pacing_candidate_b',
    {
      visibleCountLaneFrameBudgetOverrides:
        VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_A_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES,
      visibleCountNonTargetVisibleFrameBudgetOverrides:
        VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_B_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
    },
  ),
  high_load_mode_visibility_pacing_candidate_c: createVisibilityAwareOutputPacingVariant(
    'high_load_mode_visibility_pacing_candidate_c',
    {
      visibleCountLaneFrameBudgetOverrides:
        VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_A_VISIBLE_COUNT_LANE_FRAME_BUDGET_OVERRIDES,
      visibleCountNonTargetVisibleFrameBudgetOverrides:
        VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_B_VISIBLE_COUNT_NON_TARGET_VISIBLE_FRAME_BUDGET_OVERRIDES,
      visibleCountWriteBatchLimitOverrides:
        VISIBILITY_AWARE_OUTPUT_PACING_CANDIDATE_C_VISIBLE_COUNT_WRITE_BATCH_LIMIT_OVERRIDES,
    },
  ),
  structural_heavy_load_live_surface_cap: createStructuralHeavyLoadVariant(
    'structural_heavy_load_live_surface_cap',
    STRUCTURAL_HEAVY_LOAD_VISIBLE_COUNT_ADDITIONAL_LIVE_VISIBLE_LIMIT,
  ),
  structural_heavy_load_live_surface_cap_tight: createStructuralHeavyLoadVariant(
    'structural_heavy_load_live_surface_cap_tight',
    STRUCTURAL_HEAVY_LOAD_VISIBLE_COUNT_ADDITIONAL_LIVE_VISIBLE_LIMIT_TIGHT,
  ),
  guarded_dense_overload_reference: createGuardedDenseOverloadVariant(
    'guarded_dense_overload_reference',
  ),
  guarded_dense_overload_reference_frozen_visible: createGuardedDenseOverloadVariant(
    'guarded_dense_overload_reference_frozen_visible',
    {
      denseOverloadVisibleCountAdditionalLiveVisibleLimit:
        GUARDED_DENSE_OVERLOAD_VISIBLE_COUNT_ADDITIONAL_LIVE_VISIBLE_LIMIT,
    },
  ),
  switch_target_hard_contract: createVariant('switch_target_hard_contract', {
    ...SWITCH_TARGET_HARD_CONTRACT_BASE_EXPERIMENTS,
    switchWindowSettleDelayMs: 72,
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
  }),
  switch_target_hard_contract_long_settle: createVariant(
    'switch_target_hard_contract_long_settle',
    {
      ...SWITCH_TARGET_HARD_CONTRACT_BASE_EXPERIMENTS,
      switchWindowSettleDelayMs: 120,
      visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_MULTI_VISIBLE_BALANCED,
    },
  ),
  frame_budgeted_adaptive_tight: createVariant('frame_budgeted_adaptive_tight', {
    ...SHORT_FOCUSED_PREEMPTION,
    adaptiveVisibleBackgroundThrottleMode: 'moderate',
    visibilityAwareLaneFrameBudgetOverrides: FRAME_BUDGET_VISIBLE_TIGHT,
  }),
  hidden_session_dormancy: createVariant('hidden_session_dormancy', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    hiddenTerminalSessionDormancyDelayMs: 900,
  }),
  hidden_session_dormancy_preemption: createVariant('hidden_session_dormancy_preemption', {
    focusedPreemptionDrainScope: 'focused',
    focusedPreemptionWindowMs: 250,
    hiddenTerminalSessionDormancyDelayMs: 900,
  }),
  visible_write_shaping: createVariant('visible_write_shaping', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    writeBatchLimitOverrides: WRITE_BATCH_LIMIT_OVERRIDES,
  }),
  visible_write_shaping_16k: createVariant('visible_write_shaping_16k', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    writeBatchLimitOverrides: WRITE_BATCH_LIMIT_OVERRIDES_16K,
  }),
  visible_write_shaping_32k: createVariant('visible_write_shaping_32k', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    writeBatchLimitOverrides: WRITE_BATCH_LIMIT_OVERRIDES_32K,
  }),
  visible_write_shaping_64k: createVariant('visible_write_shaping_64k', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    writeBatchLimitOverrides: WRITE_BATCH_LIMIT_OVERRIDES_64K,
  }),
  visibility_aware_pacing: createVariant('visibility_aware_pacing', {
    ...SHORT_FOCUSED_PREEMPTION,
    visibilityAwareDrainCandidateLimitOverrides: VISIBILITY_AWARE_CANDIDATE_LIMIT_OVERRIDES,
    visibilityAwareWriteBatchLimitOverrides: VISIBILITY_AWARE_WRITE_BATCH_LIMIT_OVERRIDES,
  }),
  background_budget_tuned: createVariant('background_budget_tuned', {
    ...PREEMPTION_DISABLED_EXPERIMENTS,
    backgroundDrainDelayMs: 96,
    drainBudgetOverrides: BACKGROUND_BUDGET_OVERRIDES,
  }),
  hibernation_preemption: createVariant('hibernation_preemption', {
    focusedPreemptionDrainScope: 'focused',
    focusedPreemptionWindowMs: 400,
    hiddenTerminalHibernationDelayMs: 900,
  }),
  tiered_hidden_lifecycle: createVariant('tiered_hidden_lifecycle', TIERED_HIDDEN_LIFECYCLE),
  tiered_hidden_lifecycle_preemption: createVariant('tiered_hidden_lifecycle_preemption', {
    ...SHORT_FOCUSED_PREEMPTION,
    hiddenTerminalHibernationDelayMs: 900,
    hiddenTerminalSessionDormancyDelayMs: 2_400,
  }),
  all_combined: createVariant('all_combined', {
    backgroundDrainDelayMs: 96,
    drainBudgetOverrides: BACKGROUND_BUDGET_OVERRIDES,
    focusedPreemptionDrainScope: 'focused',
    focusedPreemptionWindowMs: 400,
    hiddenTerminalHibernationDelayMs: 900,
    writeBatchLimitOverrides: WRITE_BATCH_LIMIT_OVERRIDES,
  }),
});

const DEFAULT_TERMINAL_UI_FLUIDITY_VARIANTS = Object.freeze([
  'baseline',
  'product_default',
  'focused_preemption',
  'focused_preemption_150',
  'focused_preemption_250',
  'focused_preemption_visible',
  'focused_preemption_limited',
  'frame_budgeted_visible_balanced',
  'frame_budgeted_visible_tight',
  'adaptive_visible_background_moderate',
  'adaptive_visible_background_moderate_multi_visible',
  'adaptive_visible_background_aggressive',
  'frame_budgeted_adaptive_balanced',
  'frame_budgeted_adaptive_multi_visible',
  'frame_budgeted_adaptive_multi_visible_switch',
  'switch_target_balanced',
  'switch_target_balanced_pressure_yield',
  'switch_target_balanced_pressure_yield_aggressive',
  'switch_target_frame_shaped',
  'switch_target_shared_visible_budget',
  'switch_target_shared_visible_budget_tight',
  'switch_target_visible_reserve_balanced',
  'switch_target_visible_reserve_tight',
  'switch_target_visible_reserve_frame_shaped_balanced',
  'switch_target_visible_reserve_frame_shaped_tight',
  'switch_target_hard_contract',
  'switch_target_hard_contract_long_settle',
  'frame_budgeted_adaptive_tight',
  'render_freeze',
  'render_freeze_preemption_150',
  'render_freeze_intent_prewarm',
  'live_surface_tiering_1',
  'live_surface_tiering_2',
  'live_surface_tiering_2_dormant_cold',
  'hidden_session_dormancy',
  'hidden_session_dormancy_preemption',
  'tiered_hidden_lifecycle',
  'tiered_hidden_lifecycle_preemption',
  'visibility_aware_pacing',
]);

function getTerminalUiFluidityVariant(name) {
  const variant = TERMINAL_UI_FLUIDITY_VARIANTS[name];
  if (!variant) {
    throw new Error(`Unknown terminal UI fluidity variant: ${name}`);
  }

  return variant;
}

function listTerminalUiFluidityVariants() {
  return [...DEFAULT_TERMINAL_UI_FLUIDITY_VARIANTS];
}

export {
  DEFAULT_TERMINAL_UI_FLUIDITY_VARIANTS,
  getTerminalUiFluidityVariant,
  listTerminalUiFluidityVariants,
  TERMINAL_UI_FLUIDITY_VARIANTS,
};
