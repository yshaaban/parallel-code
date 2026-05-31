import { getInitialTerminalHighLoadModeEnabled } from './terminal-high-load-mode-bootstrap';

type TerminalOutputPriorityName =
  | 'focused'
  | 'switch-target-visible'
  | 'active-visible'
  | 'visible-background'
  | 'hidden';
type TerminalOutputDrainLaneName = 'focused' | 'visible' | 'hidden';
type TerminalFramePressureLevelName = 'critical' | 'elevated' | 'stable';
type TerminalDenseOverloadPressureFloorName = 'critical' | 'elevated';
type FocusedPreemptionDrainScope = 'all' | 'focused' | 'visible';
type AdaptiveVisibleBackgroundThrottleMode = 'aggressive' | 'moderate' | 'off';
type TerminalVisibilityDensityName = 'dense' | 'few' | 'single';
type TerminalStartupHiddenReplayUnblockPhase = 'all-visible-paint' | 'off' | 'selected-paint';
type TerminalStartupTaskSchedulingMode = 'off' | 'post-task' | 'yield-only';
type TerminalStartupTaskSchedulingRole = 'hidden' | 'selected' | 'visible-sibling';
type TerminalStartupVisibleSiblingReplayUnblockPhase =
  | 'first-paint'
  | 'input-ready'
  | 'paint-settled';
type TerminalInputAcknowledgementMode = 'off' | 'pulse';
export type TerminalLocalInputFeedbackMode = 'ack-pulse' | 'off';
type TerminalVisibleWebglAcquisitionMode = 'focused-only' | 'visible-set';
type TerminalVisibleCountKey = `${number}`;
type TerminalPerformancePriorityNumberRecord = Partial<Record<TerminalOutputPriorityName, number>>;
type TerminalPerformancePriorityBooleanRecord = Partial<
  Record<TerminalOutputPriorityName, boolean>
>;
type TerminalPerformanceLaneNumberRecord = Partial<Record<TerminalOutputDrainLaneName, number>>;
type TerminalPerformancePressureNumberRecord = Partial<
  Record<TerminalFramePressureLevelName, number>
>;
type TerminalPerformancePriorityPressureNumberRecord = Partial<
  Record<TerminalOutputPriorityName, TerminalPerformancePressureNumberRecord>
>;
type TerminalPerformanceVisibilityPriorityNumberRecord = Partial<
  Record<TerminalVisibilityDensityName, TerminalPerformancePriorityNumberRecord>
>;
type TerminalPerformanceVisibilityLaneNumberRecord = Partial<
  Record<TerminalVisibilityDensityName, TerminalPerformanceLaneNumberRecord>
>;
type TerminalPerformanceVisibilityNumberRecord = Partial<
  Record<TerminalVisibilityDensityName, number>
>;
type TerminalPerformanceVisibleCountPriorityNumberRecord = Partial<
  Record<TerminalVisibleCountKey, TerminalPerformancePriorityNumberRecord>
>;
type TerminalPerformanceVisibleCountLaneNumberRecord = Partial<
  Record<TerminalVisibleCountKey, TerminalPerformanceLaneNumberRecord>
>;
type TerminalPerformanceVisibleCountNumberRecord = Partial<Record<TerminalVisibleCountKey, number>>;
type TerminalPerformanceVisibleCountPressureNumberRecord = Partial<
  Record<TerminalVisibleCountKey, TerminalPerformancePressureNumberRecord>
>;
type TerminalPerformanceVisibleCountPriorityPressureNumberRecord = Partial<
  Record<TerminalVisibleCountKey, TerminalPerformancePriorityPressureNumberRecord>
>;

interface TerminalPerformanceShippedPolicyConfigInput {
  focusedPreemptionDrainScope?: FocusedPreemptionDrainScope;
  label?: string;
  multiVisiblePressureMinimumVisibleCount?: number;
  multiVisiblePressureNonTargetVisibleFrameBudgetScales?: TerminalPerformancePressureNumberRecord;
  multiVisiblePressureWriteBatchLimitScales?: TerminalPerformancePriorityPressureNumberRecord;
  adaptiveVisibleBackgroundThrottleMode?: AdaptiveVisibleBackgroundThrottleMode;
  adaptiveVisibleBackgroundMinimumVisibleCount?: number;
  switchTargetWindowMs?: number;
  visibleCountLaneFrameBudgetOverrides?: TerminalPerformanceVisibleCountLaneNumberRecord;
  visibleCountNonTargetVisibleFrameBudgetOverrides?: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountPressureNonTargetVisibleFrameBudgetScales?: TerminalPerformanceVisibleCountPressureNumberRecord;
  visibleCountPressureWriteBatchLimitScales?: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  visibleCountPressureDrainBudgetScales?: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  visibleCountSwitchTargetReserveBytes?: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountWriteBatchLimitOverrides?: TerminalPerformanceVisibleCountPriorityNumberRecord;
  visibilityAwareLaneFrameBudgetOverrides?: TerminalPerformanceVisibilityLaneNumberRecord;
  visibilityAwareNonTargetVisibleFrameBudgetOverrides?: TerminalPerformanceVisibilityNumberRecord;
  visibilityAwareSwitchTargetReserveBytes?: TerminalPerformanceVisibilityNumberRecord;
  visibilityAwareWriteBatchLimitOverrides?: TerminalPerformanceVisibilityPriorityNumberRecord;
}

interface TerminalPerformanceExploratoryConfigInput {
  adaptiveActiveVisibleMinimumVisibleCount?: number;
  adaptiveActiveVisibleThrottleMode?: AdaptiveVisibleBackgroundThrottleMode;
  backgroundDrainDelayMs?: number;
  denseOverloadMinimumVisibleCount?: number;
  denseOverloadPressureFloor?: TerminalDenseOverloadPressureFloorName;
  denseOverloadVisibleCountLaneFrameBudgetOverrides?: TerminalPerformanceVisibleCountLaneNumberRecord;
  denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides?: TerminalPerformanceVisibleCountNumberRecord;
  denseOverloadVisibleCountPressureDrainBudgetScales?: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  denseOverloadVisibleCountPressureWriteBatchLimitScales?: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  denseOverloadVisibleCountSwitchTargetReserveBytes?: TerminalPerformanceVisibleCountNumberRecord;
  denseOverloadVisibleCountWriteBatchLimitOverrides?: TerminalPerformanceVisibleCountPriorityNumberRecord;
  drainCandidateLimitOverrides?: Partial<Record<TerminalOutputPriorityName, number>>;
  drainBudgetOverrides?: Partial<Record<TerminalOutputPriorityName, number>>;
  hiddenTerminalHibernationDelayMs?: number;
  hiddenTerminalHotCount?: number;
  hiddenTerminalSessionDormancyDelayMs?: number;
  inputAcknowledgementDurationMs?: number;
  inputAcknowledgementMode?: TerminalInputAcknowledgementMode;
  laneFrameBudgetOverrides?: Partial<Record<TerminalOutputDrainLaneName, number>>;
  localInputFeedbackDurationMs?: number;
  localInputFeedbackMode?: TerminalLocalInputFeedbackMode;
  sidebarIntentPrewarmDelayMs?: number;
  statusFlushDelayOverridesMs?: Partial<Record<TerminalOutputPriorityName, number>>;
  startupAttachChunkByteOverrides?: Partial<Record<TerminalOutputPriorityName, number>>;
  startupAttachSwitchWindowChunkByteOverrides?: Partial<Record<TerminalOutputPriorityName, number>>;
  startupAttachYieldOverrides?: TerminalPerformancePriorityBooleanRecord;
  startupHiddenReplayUnblockPhase?: TerminalStartupHiddenReplayUnblockPhase;
  startupTaskSchedulingMode?: TerminalStartupTaskSchedulingMode;
  startupTaskSchedulingRoles?: Partial<Record<TerminalStartupTaskSchedulingRole, boolean>>;
  startupVisibleSiblingSessionFitGateUntilSelectedPaintReady?: boolean;
  startupSkipNonSelectedVisibleSessionRafFit?: boolean;
  startupVisibleSiblingReplayUnblockPhase?: TerminalStartupVisibleSiblingReplayUnblockPhase;
  switchPostInputReadyFirstFocusedWriteBatchLimitBytes?: number;
  switchWindowNonTargetVisibleCandidateLimit?: number;
  switchPostInputReadyEchoGraceMs?: number;
  switchWindowSettleDelayMs?: number;
  switchTargetProtectUntilInputReady?: boolean;
  visibleWebglAcquisitionMode?: TerminalVisibleWebglAcquisitionMode;
  visibleWebglContextLimit?: number;
  visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes?: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountSwitchPostInputReadyEchoGraceMs?: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountSwitchTargetWindowMs?: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountDrainBudgetOverrides?: TerminalPerformanceVisibleCountPriorityNumberRecord;
  visibleCountDrainCandidateLimitOverrides?: TerminalPerformanceVisibleCountPriorityNumberRecord;
  visibilityAwareDrainBudgetOverrides?: TerminalPerformanceVisibilityPriorityNumberRecord;
  visibilityAwareDrainCandidateLimitOverrides?: TerminalPerformanceVisibilityPriorityNumberRecord;
  writeBatchLimitOverrides?: Partial<Record<TerminalOutputPriorityName, number>>;
}

interface TerminalPerformanceExperimentConfigInput
  extends TerminalPerformanceShippedPolicyConfigInput, TerminalPerformanceExploratoryConfigInput {
  focusedPreemptionWindowMs?: number;
}

interface TerminalPerformanceShippedPolicyConfig {
  adaptiveVisibleBackgroundThrottleMode: AdaptiveVisibleBackgroundThrottleMode;
  adaptiveVisibleBackgroundMinimumVisibleCount: number;
  focusedPreemptionDrainScope: FocusedPreemptionDrainScope;
  focusedPreemptionWindowMs: number;
  label: string;
  multiVisiblePressureMinimumVisibleCount: number;
  multiVisiblePressureNonTargetVisibleFrameBudgetScales: TerminalPerformancePressureNumberRecord;
  multiVisiblePressureWriteBatchLimitScales: TerminalPerformancePriorityPressureNumberRecord;
  switchTargetWindowMs: number;
  visibleCountLaneFrameBudgetOverrides: TerminalPerformanceVisibleCountLaneNumberRecord;
  visibleCountNonTargetVisibleFrameBudgetOverrides: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountPressureNonTargetVisibleFrameBudgetScales: TerminalPerformanceVisibleCountPressureNumberRecord;
  visibleCountPressureWriteBatchLimitScales: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  visibleCountPressureDrainBudgetScales: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  visibleCountSwitchTargetReserveBytes: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountWriteBatchLimitOverrides: TerminalPerformanceVisibleCountPriorityNumberRecord;
  visibilityAwareLaneFrameBudgetOverrides: TerminalPerformanceVisibilityLaneNumberRecord;
  visibilityAwareNonTargetVisibleFrameBudgetOverrides: TerminalPerformanceVisibilityNumberRecord;
  visibilityAwareSwitchTargetReserveBytes: TerminalPerformanceVisibilityNumberRecord;
  visibilityAwareWriteBatchLimitOverrides: TerminalPerformanceVisibilityPriorityNumberRecord;
}

interface TerminalPerformanceExploratoryConfig {
  adaptiveActiveVisibleMinimumVisibleCount: number;
  adaptiveActiveVisibleThrottleMode: AdaptiveVisibleBackgroundThrottleMode;
  backgroundDrainDelayMs: number | null;
  denseOverloadMinimumVisibleCount: number;
  denseOverloadPressureFloor: TerminalDenseOverloadPressureFloorName | null;
  denseOverloadVisibleCountLaneFrameBudgetOverrides: TerminalPerformanceVisibleCountLaneNumberRecord;
  denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides: TerminalPerformanceVisibleCountNumberRecord;
  denseOverloadVisibleCountPressureDrainBudgetScales: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  denseOverloadVisibleCountPressureWriteBatchLimitScales: TerminalPerformanceVisibleCountPriorityPressureNumberRecord;
  denseOverloadVisibleCountSwitchTargetReserveBytes: TerminalPerformanceVisibleCountNumberRecord;
  denseOverloadVisibleCountWriteBatchLimitOverrides: TerminalPerformanceVisibleCountPriorityNumberRecord;
  drainCandidateLimitOverrides: Partial<Record<TerminalOutputPriorityName, number>>;
  drainBudgetOverrides: Partial<Record<TerminalOutputPriorityName, number>>;
  hiddenTerminalHibernationDelayMs: number | null;
  hiddenTerminalHotCount: number | null;
  hiddenTerminalSessionDormancyDelayMs: number | null;
  inputAcknowledgementDurationMs: number;
  inputAcknowledgementMode: TerminalInputAcknowledgementMode;
  laneFrameBudgetOverrides: Partial<Record<TerminalOutputDrainLaneName, number>>;
  localInputFeedbackDurationMs: number;
  localInputFeedbackMode: TerminalLocalInputFeedbackMode;
  sidebarIntentPrewarmDelayMs: number | null;
  statusFlushDelayOverridesMs: Partial<Record<TerminalOutputPriorityName, number>>;
  startupAttachChunkByteOverrides: Partial<Record<TerminalOutputPriorityName, number>>;
  startupAttachSwitchWindowChunkByteOverrides: Partial<Record<TerminalOutputPriorityName, number>>;
  startupAttachYieldOverrides: TerminalPerformancePriorityBooleanRecord;
  startupHiddenReplayUnblockPhase: TerminalStartupHiddenReplayUnblockPhase;
  startupTaskSchedulingMode: TerminalStartupTaskSchedulingMode;
  startupTaskSchedulingRoles: Partial<Record<TerminalStartupTaskSchedulingRole, boolean>>;
  startupVisibleSiblingSessionFitGateUntilSelectedPaintReady: boolean;
  startupSkipNonSelectedVisibleSessionRafFit: boolean;
  startupVisibleSiblingReplayUnblockPhase: TerminalStartupVisibleSiblingReplayUnblockPhase;
  switchPostInputReadyFirstFocusedWriteBatchLimitBytes: number;
  switchWindowNonTargetVisibleCandidateLimit: number | null;
  switchPostInputReadyEchoGraceMs: number;
  switchWindowSettleDelayMs: number;
  switchTargetProtectUntilInputReady: boolean;
  visibleWebglAcquisitionMode: TerminalVisibleWebglAcquisitionMode;
  visibleWebglContextLimit: number;
  visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountSwitchPostInputReadyEchoGraceMs: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountSwitchTargetWindowMs: TerminalPerformanceVisibleCountNumberRecord;
  visibleCountDrainBudgetOverrides: TerminalPerformanceVisibleCountPriorityNumberRecord;
  visibleCountDrainCandidateLimitOverrides: TerminalPerformanceVisibleCountPriorityNumberRecord;
  visibilityAwareDrainBudgetOverrides: TerminalPerformanceVisibilityPriorityNumberRecord;
  visibilityAwareDrainCandidateLimitOverrides: TerminalPerformanceVisibilityPriorityNumberRecord;
  writeBatchLimitOverrides: Partial<Record<TerminalOutputPriorityName, number>>;
}

export interface TerminalPerformanceExperimentConfig
  extends TerminalPerformanceShippedPolicyConfig, TerminalPerformanceExploratoryConfig {}

interface TerminalPerformanceExperimentConfigSections {
  exploratory: TerminalPerformanceExploratoryConfig;
  shippedPolicy: TerminalPerformanceShippedPolicyConfig;
}

declare global {
  interface Window {
    __PARALLEL_CODE_TERMINAL_EXPERIMENTS__?: TerminalPerformanceExperimentConfigInput;
  }
}

const TERMINAL_OUTPUT_PRIORITIES: readonly TerminalOutputPriorityName[] = [
  'focused',
  'switch-target-visible',
  'active-visible',
  'visible-background',
  'hidden',
];
const TERMINAL_OUTPUT_DRAIN_LANES: readonly TerminalOutputDrainLaneName[] = [
  'focused',
  'visible',
  'hidden',
];
const TERMINAL_FRAME_PRESSURE_LEVELS: readonly TerminalFramePressureLevelName[] = [
  'stable',
  'elevated',
  'critical',
];
const TERMINAL_VISIBILITY_DENSITIES: readonly TerminalVisibilityDensityName[] = [
  'single',
  'few',
  'dense',
];
const ADAPTIVE_VISIBLE_BACKGROUND_THROTTLE_MODES = new Set<AdaptiveVisibleBackgroundThrottleMode>([
  'off',
  'moderate',
  'aggressive',
]);
const STARTUP_HIDDEN_REPLAY_UNBLOCK_PHASES = new Set<TerminalStartupHiddenReplayUnblockPhase>([
  'all-visible-paint',
  'off',
  'selected-paint',
]);
const STARTUP_TASK_SCHEDULING_MODES = new Set<TerminalStartupTaskSchedulingMode>([
  'off',
  'post-task',
  'yield-only',
]);
const TERMINAL_STARTUP_TASK_SCHEDULING_ROLES = new Set<TerminalStartupTaskSchedulingRole>([
  'hidden',
  'selected',
  'visible-sibling',
]);
const STARTUP_VISIBLE_SIBLING_REPLAY_UNBLOCK_PHASES =
  new Set<TerminalStartupVisibleSiblingReplayUnblockPhase>([
    'first-paint',
    'input-ready',
    'paint-settled',
  ]);
const TERMINAL_DENSE_OVERLOAD_PRESSURE_FLOORS = new Set<TerminalDenseOverloadPressureFloorName>([
  'critical',
  'elevated',
]);
const TERMINAL_VISIBLE_WEBGL_ACQUISITION_MODES = new Set<TerminalVisibleWebglAcquisitionMode>([
  'focused-only',
  'visible-set',
]);
const TERMINAL_INPUT_ACKNOWLEDGEMENT_MODES = new Set<TerminalInputAcknowledgementMode>([
  'off',
  'pulse',
]);
const TERMINAL_LOCAL_INPUT_FEEDBACK_MODES = new Set<TerminalLocalInputFeedbackMode>([
  'ack-pulse',
  'off',
]);

const DEFAULT_FOCUSED_PREEMPTION_DRAIN_SCOPE = 'focused';
const DEFAULT_FOCUSED_PREEMPTION_WINDOW_MS = 150;
const DEFAULT_EXPERIMENT_LABEL = 'default';
const DEFAULT_INPUT_ACKNOWLEDGEMENT_DURATION_MS = 180;
const DEFAULT_LOCAL_INPUT_FEEDBACK_DURATION_MS = 180;
const DEFAULT_VISIBLE_WEBGL_CONTEXT_LIMIT = 4;
const FOCUSED_PREEMPTION_DRAIN_SCOPES = new Set<FocusedPreemptionDrainScope>([
  'all',
  'focused',
  'visible',
]);

const DEFAULT_TERMINAL_PERFORMANCE_SHIPPED_POLICY_CONFIG: TerminalPerformanceShippedPolicyConfig = {
  adaptiveVisibleBackgroundThrottleMode: 'off',
  adaptiveVisibleBackgroundMinimumVisibleCount: 1,
  focusedPreemptionDrainScope: DEFAULT_FOCUSED_PREEMPTION_DRAIN_SCOPE,
  focusedPreemptionWindowMs: DEFAULT_FOCUSED_PREEMPTION_WINDOW_MS,
  label: DEFAULT_EXPERIMENT_LABEL,
  multiVisiblePressureMinimumVisibleCount: 4,
  multiVisiblePressureNonTargetVisibleFrameBudgetScales: {},
  multiVisiblePressureWriteBatchLimitScales: {},
  switchTargetWindowMs: 0,
  visibleCountLaneFrameBudgetOverrides: {},
  visibleCountNonTargetVisibleFrameBudgetOverrides: {},
  visibleCountPressureNonTargetVisibleFrameBudgetScales: {},
  visibleCountPressureWriteBatchLimitScales: {},
  visibleCountPressureDrainBudgetScales: {},
  visibleCountSwitchTargetReserveBytes: {},
  visibleCountWriteBatchLimitOverrides: {},
  visibilityAwareLaneFrameBudgetOverrides: {},
  visibilityAwareNonTargetVisibleFrameBudgetOverrides: {},
  visibilityAwareSwitchTargetReserveBytes: {},
  visibilityAwareWriteBatchLimitOverrides: {},
};

const DEFAULT_TERMINAL_PERFORMANCE_EXPLORATORY_CONFIG: TerminalPerformanceExploratoryConfig = {
  adaptiveActiveVisibleMinimumVisibleCount: 1,
  adaptiveActiveVisibleThrottleMode: 'off',
  backgroundDrainDelayMs: null,
  denseOverloadMinimumVisibleCount: 0,
  denseOverloadPressureFloor: null,
  denseOverloadVisibleCountLaneFrameBudgetOverrides: {},
  denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides: {},
  denseOverloadVisibleCountPressureDrainBudgetScales: {},
  denseOverloadVisibleCountPressureWriteBatchLimitScales: {},
  denseOverloadVisibleCountSwitchTargetReserveBytes: {},
  denseOverloadVisibleCountWriteBatchLimitOverrides: {},
  drainCandidateLimitOverrides: {},
  drainBudgetOverrides: {},
  hiddenTerminalHibernationDelayMs: 75,
  hiddenTerminalHotCount: null,
  hiddenTerminalSessionDormancyDelayMs: null,
  inputAcknowledgementDurationMs: DEFAULT_INPUT_ACKNOWLEDGEMENT_DURATION_MS,
  inputAcknowledgementMode: 'off',
  laneFrameBudgetOverrides: {},
  localInputFeedbackDurationMs: DEFAULT_LOCAL_INPUT_FEEDBACK_DURATION_MS,
  localInputFeedbackMode: 'off',
  sidebarIntentPrewarmDelayMs: null,
  statusFlushDelayOverridesMs: {},
  startupAttachChunkByteOverrides: {},
  startupAttachSwitchWindowChunkByteOverrides: {},
  startupAttachYieldOverrides: {},
  startupHiddenReplayUnblockPhase: 'all-visible-paint',
  startupTaskSchedulingMode: 'off',
  startupTaskSchedulingRoles: {},
  startupVisibleSiblingSessionFitGateUntilSelectedPaintReady: false,
  startupSkipNonSelectedVisibleSessionRafFit: false,
  startupVisibleSiblingReplayUnblockPhase: 'input-ready',
  switchPostInputReadyFirstFocusedWriteBatchLimitBytes: 0,
  switchWindowNonTargetVisibleCandidateLimit: null,
  switchPostInputReadyEchoGraceMs: 0,
  switchWindowSettleDelayMs: 0,
  switchTargetProtectUntilInputReady: false,
  visibleWebglAcquisitionMode: 'focused-only',
  visibleWebglContextLimit: DEFAULT_VISIBLE_WEBGL_CONTEXT_LIMIT,
  visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: {},
  visibleCountSwitchPostInputReadyEchoGraceMs: {},
  visibleCountSwitchTargetWindowMs: {},
  visibleCountDrainBudgetOverrides: {},
  visibleCountDrainCandidateLimitOverrides: {},
  visibilityAwareDrainBudgetOverrides: {},
  visibilityAwareDrainCandidateLimitOverrides: {},
  writeBatchLimitOverrides: {},
};

const DEFAULT_TERMINAL_PERFORMANCE_EXPERIMENT_CONFIG_SECTIONS: TerminalPerformanceExperimentConfigSections =
  {
    exploratory: DEFAULT_TERMINAL_PERFORMANCE_EXPLORATORY_CONFIG,
    shippedPolicy: DEFAULT_TERMINAL_PERFORMANCE_SHIPPED_POLICY_CONFIG,
  };

const DEFAULT_TERMINAL_PERFORMANCE_EXPERIMENT_CONFIG = createTerminalPerformanceExperimentConfig(
  DEFAULT_TERMINAL_PERFORMANCE_EXPERIMENT_CONFIG_SECTIONS,
);

let cachedExperimentConfigInput: unknown = Symbol('unset-terminal-performance-config');
let cachedExperimentConfig = DEFAULT_TERMINAL_PERFORMANCE_EXPERIMENT_CONFIG;
let cachedHighLoadModeEnabled = false;
let cachedUrlExperimentSearch: string | null = null;
let cachedUrlExperimentConfig: TerminalPerformanceExperimentConfigInput | undefined;
const HIGH_LOAD_MODE_FEW_VISIBLE_COUNT = '2';
const HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT = '4';
const HIGH_LOAD_MODE_DENSE_FALLBACK_VISIBLE_LANE_FRAME_BUDGET_BYTES = 40 * 1024;
const HIGH_LOAD_MODE_DENSE_FALLBACK_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES = 8 * 1024;
const HIGH_LOAD_MODE_DENSE_FALLBACK_SWITCH_TARGET_RESERVE_BYTES = 16 * 1024;
const HIGH_LOAD_MODE_MULTI_VISIBLE_LANE_FRAME_BUDGET_BYTES = 56 * 1024;
const HIGH_LOAD_MODE_MULTI_VISIBLE_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES = 16 * 1024;
const HIGH_LOAD_MODE_DENSE_PRESSURE_FOCUSED_BUDGET_SCALES = Object.freeze({
  critical: 1.5,
  elevated: 1.25,
});
const HIGH_LOAD_MODE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES = Object.freeze({
  critical: 0.125,
  elevated: 0.375,
});
const HIGH_LOAD_MODE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES = Object.freeze({
  critical: 0.125,
  elevated: 0.375,
});
const HIGH_LOAD_MODE_SWITCH_TARGET_WINDOW_MS = 250;
const HIGH_LOAD_MODE_DENSE_FALLBACK_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  'active-visible': 8 * 1024,
  focused: 24 * 1024,
  hidden: 8 * 1024,
  'switch-target-visible': 24 * 1024,
  'visible-background': 8 * 1024,
});
const HIGH_LOAD_MODE_MULTI_VISIBLE_WRITE_BATCH_LIMIT_OVERRIDES = Object.freeze({
  'active-visible': 12 * 1024,
  focused: 32 * 1024,
  hidden: 8 * 1024,
  'switch-target-visible': 32 * 1024,
  'visible-background': 8 * 1024,
});
const HIGH_LOAD_MODE_MULTI_VISIBLE_SWITCH_TARGET_RESERVE_BYTES = 24 * 1024;
const HIGH_LOAD_MODE_HIDDEN_TERMINAL_HIBERNATION_DELAY_MS =
  DEFAULT_TERMINAL_PERFORMANCE_EXPLORATORY_CONFIG.hiddenTerminalHibernationDelayMs;
const HIGH_LOAD_MODE_SPARSE_SWITCH_POST_INPUT_READY_ECHO_GRACE_MS = 180;
const HIGH_LOAD_MODE_SPARSE_SWITCH_FIRST_FOCUSED_WRITE_BATCH_LIMIT_BYTES = 8 * 1024;

const HIGH_LOAD_MODE_PRODUCT_CONFIG: Readonly<TerminalPerformanceExperimentConfigInput> =
  Object.freeze({
    adaptiveVisibleBackgroundMinimumVisibleCount: 2,
    adaptiveVisibleBackgroundThrottleMode: 'moderate',
    focusedPreemptionDrainScope: 'focused',
    focusedPreemptionWindowMs: 150,
    hiddenTerminalHibernationDelayMs: HIGH_LOAD_MODE_HIDDEN_TERMINAL_HIBERNATION_DELAY_MS ?? 75,
    label: 'high_load_mode',
    multiVisiblePressureMinimumVisibleCount: 4,
    multiVisiblePressureNonTargetVisibleFrameBudgetScales: Object.freeze({
      critical: 0.125,
      elevated: 0.375,
    }),
    multiVisiblePressureWriteBatchLimitScales: Object.freeze({
      'visible-background': Object.freeze({
        critical: 0.125,
        elevated: 0.375,
      }),
    }),
    visibilityAwareLaneFrameBudgetOverrides: Object.freeze({
      dense: Object.freeze({
        visible: HIGH_LOAD_MODE_DENSE_FALLBACK_VISIBLE_LANE_FRAME_BUDGET_BYTES,
      }),
    }),
    visibilityAwareNonTargetVisibleFrameBudgetOverrides: Object.freeze({
      dense: HIGH_LOAD_MODE_DENSE_FALLBACK_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES,
    }),
    visibilityAwareSwitchTargetReserveBytes: Object.freeze({
      dense: HIGH_LOAD_MODE_DENSE_FALLBACK_SWITCH_TARGET_RESERVE_BYTES,
    }),
    visibilityAwareWriteBatchLimitOverrides: Object.freeze({
      dense: HIGH_LOAD_MODE_DENSE_FALLBACK_WRITE_BATCH_LIMIT_OVERRIDES,
    }),
    switchTargetWindowMs: HIGH_LOAD_MODE_SWITCH_TARGET_WINDOW_MS,
    visibleCountSwitchPostInputReadyEchoGraceMs: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_SPARSE_SWITCH_POST_INPUT_READY_ECHO_GRACE_MS,
      '1': HIGH_LOAD_MODE_SPARSE_SWITCH_POST_INPUT_READY_ECHO_GRACE_MS,
    }),
    visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_SPARSE_SWITCH_FIRST_FOCUSED_WRITE_BATCH_LIMIT_BYTES,
      '1': HIGH_LOAD_MODE_SPARSE_SWITCH_FIRST_FOCUSED_WRITE_BATCH_LIMIT_BYTES,
    }),
    visibleCountLaneFrameBudgetOverrides: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]: Object.freeze({
        visible: HIGH_LOAD_MODE_MULTI_VISIBLE_LANE_FRAME_BUDGET_BYTES,
      }),
      [HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT]: Object.freeze({
        visible: HIGH_LOAD_MODE_MULTI_VISIBLE_LANE_FRAME_BUDGET_BYTES,
      }),
    }),
    visibleCountNonTargetVisibleFrameBudgetOverrides: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_MULTI_VISIBLE_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES,
      [HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_MULTI_VISIBLE_NON_TARGET_VISIBLE_FRAME_BUDGET_BYTES,
    }),
    visibleCountPressureNonTargetVisibleFrameBudgetScales: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_PRESSURE_NON_TARGET_VISIBLE_FRAME_BUDGET_SCALES,
    }),
    visibleCountPressureDrainBudgetScales: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]: Object.freeze({
        focused: HIGH_LOAD_MODE_DENSE_PRESSURE_FOCUSED_BUDGET_SCALES,
      }),
      [HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT]: Object.freeze({
        focused: HIGH_LOAD_MODE_DENSE_PRESSURE_FOCUSED_BUDGET_SCALES,
      }),
    }),
    visibleCountPressureWriteBatchLimitScales: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]: Object.freeze({
        focused: HIGH_LOAD_MODE_DENSE_PRESSURE_FOCUSED_BUDGET_SCALES,
        'visible-background': HIGH_LOAD_MODE_PRESSURE_VISIBLE_BACKGROUND_WRITE_BATCH_LIMIT_SCALES,
      }),
      [HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT]: Object.freeze({
        focused: HIGH_LOAD_MODE_DENSE_PRESSURE_FOCUSED_BUDGET_SCALES,
      }),
    }),
    visibleCountSwitchTargetReserveBytes: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]: HIGH_LOAD_MODE_MULTI_VISIBLE_SWITCH_TARGET_RESERVE_BYTES,
      [HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_MULTI_VISIBLE_SWITCH_TARGET_RESERVE_BYTES,
    }),
    visibleCountWriteBatchLimitOverrides: Object.freeze({
      [HIGH_LOAD_MODE_FEW_VISIBLE_COUNT]: HIGH_LOAD_MODE_MULTI_VISIBLE_WRITE_BATCH_LIMIT_OVERRIDES,
      [HIGH_LOAD_MODE_DENSE_VISIBLE_COUNT]:
        HIGH_LOAD_MODE_MULTI_VISIBLE_WRITE_BATCH_LIMIT_OVERRIDES,
    }),
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getPositiveFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

function getPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function getNonNegativeIntegerOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function normalizePriorityNumberRecord(
  value: unknown,
): Partial<Record<TerminalOutputPriorityName, number>> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Partial<Record<TerminalOutputPriorityName, number>> = {};
  for (const priority of TERMINAL_OUTPUT_PRIORITIES) {
    const nextValue = getPositiveFiniteNumberOrNull(value[priority]);
    if (nextValue !== null) {
      normalized[priority] = nextValue;
    }
  }
  return normalized;
}

function normalizePriorityBooleanRecord(
  value: unknown,
): Partial<Record<TerminalOutputPriorityName, boolean>> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Partial<Record<TerminalOutputPriorityName, boolean>> = {};
  for (const priority of TERMINAL_OUTPUT_PRIORITIES) {
    if (typeof value[priority] === 'boolean') {
      normalized[priority] = value[priority];
    }
  }

  return normalized;
}

function normalizeLaneNumberRecord(
  value: unknown,
): Partial<Record<TerminalOutputDrainLaneName, number>> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Partial<Record<TerminalOutputDrainLaneName, number>> = {};
  for (const lane of TERMINAL_OUTPUT_DRAIN_LANES) {
    const nextValue = getPositiveFiniteNumberOrNull(value[lane]);
    if (nextValue !== null) {
      normalized[lane] = nextValue;
    }
  }

  return normalized;
}

function normalizeVisibilityPriorityNumberRecord(
  value: unknown,
): TerminalPerformanceVisibilityPriorityNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibilityPriorityNumberRecord = {};
  for (const density of TERMINAL_VISIBILITY_DENSITIES) {
    const normalizedPriorityRecord = normalizePriorityNumberRecord(value[density]);
    if (Object.keys(normalizedPriorityRecord).length > 0) {
      normalized[density] = normalizedPriorityRecord;
    }
  }

  return normalized;
}

function normalizeVisibilityLaneNumberRecord(
  value: unknown,
): TerminalPerformanceVisibilityLaneNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibilityLaneNumberRecord = {};
  for (const density of TERMINAL_VISIBILITY_DENSITIES) {
    const normalizedLaneRecord = normalizeLaneNumberRecord(value[density]);
    if (Object.keys(normalizedLaneRecord).length > 0) {
      normalized[density] = normalizedLaneRecord;
    }
  }

  return normalized;
}

function normalizeVisibilityNumberRecord(
  value: unknown,
): TerminalPerformanceVisibilityNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibilityNumberRecord = {};
  for (const density of TERMINAL_VISIBILITY_DENSITIES) {
    const nextValue = getPositiveFiniteNumberOrNull(value[density]);
    if (nextValue !== null) {
      normalized[density] = nextValue;
    }
  }

  return normalized;
}

function normalizeVisibleCountKey(value: string): TerminalVisibleCountKey | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return null;
  }

  return `${parsedValue}` as TerminalVisibleCountKey;
}

function isStringLiteralSetMember<TValue extends string>(
  allowedValues: ReadonlySet<TValue>,
  value: unknown,
): value is TValue {
  return typeof value === 'string' && allowedValues.has(value as TValue);
}

function getVisibleCountKey(visibleTerminalCount: number): TerminalVisibleCountKey | null {
  if (!Number.isInteger(visibleTerminalCount) || visibleTerminalCount <= 0) {
    return null;
  }

  return `${visibleTerminalCount}` as TerminalVisibleCountKey;
}

function normalizeVisibleCountPriorityNumberRecord(
  value: unknown,
): TerminalPerformanceVisibleCountPriorityNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibleCountPriorityNumberRecord = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const visibleCountKey = normalizeVisibleCountKey(rawKey);
    if (visibleCountKey === null) {
      continue;
    }

    const normalizedPriorityRecord = normalizePriorityNumberRecord(rawValue);
    if (Object.keys(normalizedPriorityRecord).length > 0) {
      normalized[visibleCountKey] = normalizedPriorityRecord;
    }
  }

  return normalized;
}

function normalizeVisibleCountLaneNumberRecord(
  value: unknown,
): TerminalPerformanceVisibleCountLaneNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibleCountLaneNumberRecord = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const visibleCountKey = normalizeVisibleCountKey(rawKey);
    if (visibleCountKey === null) {
      continue;
    }

    const normalizedLaneRecord = normalizeLaneNumberRecord(rawValue);
    if (Object.keys(normalizedLaneRecord).length > 0) {
      normalized[visibleCountKey] = normalizedLaneRecord;
    }
  }

  return normalized;
}

function normalizeVisibleCountNumberRecord(
  value: unknown,
): TerminalPerformanceVisibleCountNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibleCountNumberRecord = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const visibleCountKey = normalizeVisibleCountKey(rawKey);
    const normalizedValue =
      visibleCountKey === null ? null : getPositiveFiniteNumberOrNull(rawValue);
    if (visibleCountKey !== null && normalizedValue !== null) {
      normalized[visibleCountKey] = normalizedValue;
    }
  }

  return normalized;
}

function normalizeVisibleCountPressureNumberRecord(
  value: unknown,
): TerminalPerformanceVisibleCountPressureNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibleCountPressureNumberRecord = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const visibleCountKey = normalizeVisibleCountKey(rawKey);
    if (visibleCountKey === null) {
      continue;
    }

    const normalizedPressureRecord = normalizePressureNumberRecord(rawValue);
    if (Object.keys(normalizedPressureRecord).length > 0) {
      normalized[visibleCountKey] = normalizedPressureRecord;
    }
  }

  return normalized;
}

function normalizeVisibleCountPriorityPressureNumberRecord(
  value: unknown,
): TerminalPerformanceVisibleCountPriorityPressureNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformanceVisibleCountPriorityPressureNumberRecord = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const visibleCountKey = normalizeVisibleCountKey(rawKey);
    if (visibleCountKey === null) {
      continue;
    }

    const normalizedPriorityPressureRecord = normalizePriorityPressureNumberRecord(rawValue);
    if (Object.keys(normalizedPriorityPressureRecord).length > 0) {
      normalized[visibleCountKey] = normalizedPriorityPressureRecord;
    }
  }

  return normalized;
}

function normalizePressureNumberRecord(value: unknown): TerminalPerformancePressureNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformancePressureNumberRecord = {};
  for (const pressureLevel of TERMINAL_FRAME_PRESSURE_LEVELS) {
    const nextValue = getPositiveFiniteNumberOrNull(value[pressureLevel]);
    if (nextValue !== null) {
      normalized[pressureLevel] = nextValue;
    }
  }

  return normalized;
}

function normalizePriorityPressureNumberRecord(
  value: unknown,
): TerminalPerformancePriorityPressureNumberRecord {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: TerminalPerformancePriorityPressureNumberRecord = {};
  for (const priority of TERMINAL_OUTPUT_PRIORITIES) {
    const normalizedPressureRecord = normalizePressureNumberRecord(value[priority]);
    if (Object.keys(normalizedPressureRecord).length > 0) {
      normalized[priority] = normalizedPressureRecord;
    }
  }

  return normalized;
}

function normalizeFocusedPreemptionDrainScope(
  input: TerminalPerformanceExperimentConfigInput,
): FocusedPreemptionDrainScope {
  const configuredScope = input.focusedPreemptionDrainScope;
  if (configuredScope && FOCUSED_PREEMPTION_DRAIN_SCOPES.has(configuredScope)) {
    return configuredScope;
  }

  return DEFAULT_FOCUSED_PREEMPTION_DRAIN_SCOPE;
}

function getExperimentLabel(input: TerminalPerformanceExperimentConfigInput): string {
  if (typeof input.label !== 'string') {
    return DEFAULT_EXPERIMENT_LABEL;
  }

  const trimmedLabel = input.label.trim();
  if (trimmedLabel.length === 0) {
    return DEFAULT_EXPERIMENT_LABEL;
  }

  return trimmedLabel;
}

function normalizeAdaptiveVisibleThrottleMode(
  configuredMode: unknown,
): AdaptiveVisibleBackgroundThrottleMode {
  if (isStringLiteralSetMember(ADAPTIVE_VISIBLE_BACKGROUND_THROTTLE_MODES, configuredMode)) {
    return configuredMode;
  }

  return 'off';
}

function normalizeDenseOverloadPressureFloor(
  configuredFloor: unknown,
): TerminalDenseOverloadPressureFloorName | null {
  if (isStringLiteralSetMember(TERMINAL_DENSE_OVERLOAD_PRESSURE_FLOORS, configuredFloor)) {
    return configuredFloor;
  }

  return null;
}

function normalizeStartupVisibleSiblingReplayUnblockPhase(
  configuredPhase: unknown,
): TerminalStartupVisibleSiblingReplayUnblockPhase {
  if (isStringLiteralSetMember(STARTUP_VISIBLE_SIBLING_REPLAY_UNBLOCK_PHASES, configuredPhase)) {
    return configuredPhase;
  }

  return 'input-ready';
}

function normalizeStartupHiddenReplayUnblockPhase(
  configuredPhase: unknown,
): TerminalStartupHiddenReplayUnblockPhase {
  if (isStringLiteralSetMember(STARTUP_HIDDEN_REPLAY_UNBLOCK_PHASES, configuredPhase)) {
    return configuredPhase;
  }

  return 'all-visible-paint';
}

function normalizeStartupTaskSchedulingMode(
  configuredMode: unknown,
): TerminalStartupTaskSchedulingMode {
  if (isStringLiteralSetMember(STARTUP_TASK_SCHEDULING_MODES, configuredMode)) {
    return configuredMode;
  }

  return 'off';
}

function normalizeVisibleWebglAcquisitionMode(
  configuredMode: unknown,
): TerminalVisibleWebglAcquisitionMode {
  if (isStringLiteralSetMember(TERMINAL_VISIBLE_WEBGL_ACQUISITION_MODES, configuredMode)) {
    return configuredMode;
  }

  return 'focused-only';
}

function normalizeInputAcknowledgementMode(
  configuredMode: unknown,
): TerminalInputAcknowledgementMode {
  if (isStringLiteralSetMember(TERMINAL_INPUT_ACKNOWLEDGEMENT_MODES, configuredMode)) {
    return configuredMode;
  }

  return 'off';
}

function parseLocalInputFeedbackMode(
  configuredMode: unknown,
): TerminalLocalInputFeedbackMode | null {
  if (isStringLiteralSetMember(TERMINAL_LOCAL_INPUT_FEEDBACK_MODES, configuredMode)) {
    return configuredMode;
  }

  return null;
}

function normalizeLocalInputFeedbackMode(configuredMode: unknown): TerminalLocalInputFeedbackMode {
  const mode = parseLocalInputFeedbackMode(configuredMode);
  if (mode !== null) {
    return mode;
  }

  return 'off';
}

function normalizeStartupTaskSchedulingRoles(
  configuredRoles: unknown,
): Partial<Record<TerminalStartupTaskSchedulingRole, boolean>> {
  if (!configuredRoles || typeof configuredRoles !== 'object') {
    return {};
  }

  const normalized: Partial<Record<TerminalStartupTaskSchedulingRole, boolean>> = {};
  for (const role of TERMINAL_STARTUP_TASK_SCHEDULING_ROLES) {
    const value = (configuredRoles as Partial<Record<TerminalStartupTaskSchedulingRole, unknown>>)[
      role
    ];
    if (value === true) {
      normalized[role] = true;
    }
  }

  return normalized;
}

function normalizeFocusedPreemptionWindowMs(
  input: TerminalPerformanceExperimentConfigInput,
): number {
  if (input.focusedPreemptionWindowMs === 0) {
    return 0;
  }

  return (
    getPositiveFiniteNumberOrNull(input.focusedPreemptionWindowMs) ??
    DEFAULT_FOCUSED_PREEMPTION_WINDOW_MS
  );
}

function normalizeShippedPolicyConfig(
  input: TerminalPerformanceShippedPolicyConfigInput | undefined,
): TerminalPerformanceShippedPolicyConfig {
  if (!input) {
    return DEFAULT_TERMINAL_PERFORMANCE_SHIPPED_POLICY_CONFIG;
  }

  return {
    adaptiveVisibleBackgroundThrottleMode: normalizeAdaptiveVisibleThrottleMode(
      input.adaptiveVisibleBackgroundThrottleMode,
    ),
    adaptiveVisibleBackgroundMinimumVisibleCount:
      getPositiveIntegerOrNull(input.adaptiveVisibleBackgroundMinimumVisibleCount) ?? 1,
    focusedPreemptionDrainScope: normalizeFocusedPreemptionDrainScope(input),
    focusedPreemptionWindowMs: normalizeFocusedPreemptionWindowMs(input),
    label: getExperimentLabel(input),
    multiVisiblePressureMinimumVisibleCount:
      getPositiveIntegerOrNull(input.multiVisiblePressureMinimumVisibleCount) ?? 4,
    multiVisiblePressureNonTargetVisibleFrameBudgetScales: normalizePressureNumberRecord(
      input.multiVisiblePressureNonTargetVisibleFrameBudgetScales,
    ),
    multiVisiblePressureWriteBatchLimitScales: normalizePriorityPressureNumberRecord(
      input.multiVisiblePressureWriteBatchLimitScales,
    ),
    switchTargetWindowMs: getPositiveFiniteNumberOrNull(input.switchTargetWindowMs) ?? 0,
    visibleCountLaneFrameBudgetOverrides: normalizeVisibleCountLaneNumberRecord(
      input.visibleCountLaneFrameBudgetOverrides,
    ),
    visibleCountNonTargetVisibleFrameBudgetOverrides: normalizeVisibleCountNumberRecord(
      input.visibleCountNonTargetVisibleFrameBudgetOverrides,
    ),
    visibleCountPressureNonTargetVisibleFrameBudgetScales:
      normalizeVisibleCountPressureNumberRecord(
        input.visibleCountPressureNonTargetVisibleFrameBudgetScales,
      ),
    visibleCountPressureWriteBatchLimitScales: normalizeVisibleCountPriorityPressureNumberRecord(
      input.visibleCountPressureWriteBatchLimitScales,
    ),
    visibleCountPressureDrainBudgetScales: normalizeVisibleCountPriorityPressureNumberRecord(
      input.visibleCountPressureDrainBudgetScales,
    ),
    visibleCountSwitchTargetReserveBytes: normalizeVisibleCountNumberRecord(
      input.visibleCountSwitchTargetReserveBytes,
    ),
    visibleCountWriteBatchLimitOverrides: normalizeVisibleCountPriorityNumberRecord(
      input.visibleCountWriteBatchLimitOverrides,
    ),
    visibilityAwareLaneFrameBudgetOverrides: normalizeVisibilityLaneNumberRecord(
      input.visibilityAwareLaneFrameBudgetOverrides,
    ),
    visibilityAwareNonTargetVisibleFrameBudgetOverrides: normalizeVisibilityNumberRecord(
      input.visibilityAwareNonTargetVisibleFrameBudgetOverrides,
    ),
    visibilityAwareSwitchTargetReserveBytes: normalizeVisibilityNumberRecord(
      input.visibilityAwareSwitchTargetReserveBytes,
    ),
    visibilityAwareWriteBatchLimitOverrides: normalizeVisibilityPriorityNumberRecord(
      input.visibilityAwareWriteBatchLimitOverrides,
    ),
  };
}

function normalizeExploratoryConfig(
  input: TerminalPerformanceExploratoryConfigInput | undefined,
): TerminalPerformanceExploratoryConfig {
  if (!input) {
    return DEFAULT_TERMINAL_PERFORMANCE_EXPLORATORY_CONFIG;
  }

  return {
    adaptiveActiveVisibleMinimumVisibleCount:
      getPositiveIntegerOrNull(input.adaptiveActiveVisibleMinimumVisibleCount) ?? 1,
    adaptiveActiveVisibleThrottleMode: normalizeAdaptiveVisibleThrottleMode(
      input.adaptiveActiveVisibleThrottleMode,
    ),
    backgroundDrainDelayMs: getPositiveFiniteNumberOrNull(input.backgroundDrainDelayMs),
    denseOverloadMinimumVisibleCount:
      getNonNegativeIntegerOrNull(input.denseOverloadMinimumVisibleCount) ?? 0,
    denseOverloadPressureFloor: normalizeDenseOverloadPressureFloor(
      input.denseOverloadPressureFloor,
    ),
    denseOverloadVisibleCountLaneFrameBudgetOverrides: normalizeVisibleCountLaneNumberRecord(
      input.denseOverloadVisibleCountLaneFrameBudgetOverrides,
    ),
    denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides:
      normalizeVisibleCountNumberRecord(
        input.denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides,
      ),
    denseOverloadVisibleCountPressureDrainBudgetScales:
      normalizeVisibleCountPriorityPressureNumberRecord(
        input.denseOverloadVisibleCountPressureDrainBudgetScales,
      ),
    denseOverloadVisibleCountPressureWriteBatchLimitScales:
      normalizeVisibleCountPriorityPressureNumberRecord(
        input.denseOverloadVisibleCountPressureWriteBatchLimitScales,
      ),
    denseOverloadVisibleCountSwitchTargetReserveBytes: normalizeVisibleCountNumberRecord(
      input.denseOverloadVisibleCountSwitchTargetReserveBytes,
    ),
    denseOverloadVisibleCountWriteBatchLimitOverrides: normalizeVisibleCountPriorityNumberRecord(
      input.denseOverloadVisibleCountWriteBatchLimitOverrides,
    ),
    drainCandidateLimitOverrides: normalizePriorityNumberRecord(input.drainCandidateLimitOverrides),
    drainBudgetOverrides: normalizePriorityNumberRecord(input.drainBudgetOverrides),
    hiddenTerminalHibernationDelayMs: getPositiveFiniteNumberOrNull(
      input.hiddenTerminalHibernationDelayMs,
    ),
    hiddenTerminalHotCount: getPositiveIntegerOrNull(input.hiddenTerminalHotCount),
    hiddenTerminalSessionDormancyDelayMs: getPositiveFiniteNumberOrNull(
      input.hiddenTerminalSessionDormancyDelayMs,
    ),
    inputAcknowledgementDurationMs:
      getPositiveFiniteNumberOrNull(input.inputAcknowledgementDurationMs) ??
      DEFAULT_INPUT_ACKNOWLEDGEMENT_DURATION_MS,
    inputAcknowledgementMode: normalizeInputAcknowledgementMode(input.inputAcknowledgementMode),
    laneFrameBudgetOverrides: normalizeLaneNumberRecord(input.laneFrameBudgetOverrides),
    localInputFeedbackDurationMs:
      getPositiveFiniteNumberOrNull(input.localInputFeedbackDurationMs) ??
      DEFAULT_LOCAL_INPUT_FEEDBACK_DURATION_MS,
    localInputFeedbackMode: normalizeLocalInputFeedbackMode(input.localInputFeedbackMode),
    sidebarIntentPrewarmDelayMs: getPositiveFiniteNumberOrNull(input.sidebarIntentPrewarmDelayMs),
    statusFlushDelayOverridesMs: normalizePriorityNumberRecord(input.statusFlushDelayOverridesMs),
    startupAttachChunkByteOverrides: normalizePriorityNumberRecord(
      input.startupAttachChunkByteOverrides,
    ),
    startupAttachSwitchWindowChunkByteOverrides: normalizePriorityNumberRecord(
      input.startupAttachSwitchWindowChunkByteOverrides,
    ),
    startupAttachYieldOverrides: normalizePriorityBooleanRecord(input.startupAttachYieldOverrides),
    startupHiddenReplayUnblockPhase: normalizeStartupHiddenReplayUnblockPhase(
      input.startupHiddenReplayUnblockPhase,
    ),
    startupTaskSchedulingMode: normalizeStartupTaskSchedulingMode(input.startupTaskSchedulingMode),
    startupTaskSchedulingRoles: normalizeStartupTaskSchedulingRoles(
      input.startupTaskSchedulingRoles,
    ),
    startupVisibleSiblingSessionFitGateUntilSelectedPaintReady:
      input.startupVisibleSiblingSessionFitGateUntilSelectedPaintReady === true,
    startupSkipNonSelectedVisibleSessionRafFit:
      input.startupSkipNonSelectedVisibleSessionRafFit === true,
    startupVisibleSiblingReplayUnblockPhase: normalizeStartupVisibleSiblingReplayUnblockPhase(
      input.startupVisibleSiblingReplayUnblockPhase,
    ),
    switchPostInputReadyFirstFocusedWriteBatchLimitBytes:
      getPositiveFiniteNumberOrNull(input.switchPostInputReadyFirstFocusedWriteBatchLimitBytes) ??
      0,
    switchWindowNonTargetVisibleCandidateLimit: getPositiveIntegerOrNull(
      input.switchWindowNonTargetVisibleCandidateLimit,
    ),
    switchPostInputReadyEchoGraceMs:
      getPositiveFiniteNumberOrNull(input.switchPostInputReadyEchoGraceMs) ?? 0,
    switchWindowSettleDelayMs: getPositiveFiniteNumberOrNull(input.switchWindowSettleDelayMs) ?? 0,
    switchTargetProtectUntilInputReady: input.switchTargetProtectUntilInputReady === true,
    visibleWebglAcquisitionMode: normalizeVisibleWebglAcquisitionMode(
      input.visibleWebglAcquisitionMode,
    ),
    visibleWebglContextLimit:
      getPositiveIntegerOrNull(input.visibleWebglContextLimit) ??
      DEFAULT_VISIBLE_WEBGL_CONTEXT_LIMIT,
    visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes:
      normalizeVisibleCountNumberRecord(
        input.visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes,
      ),
    visibleCountSwitchPostInputReadyEchoGraceMs: normalizeVisibleCountNumberRecord(
      input.visibleCountSwitchPostInputReadyEchoGraceMs,
    ),
    visibleCountSwitchTargetWindowMs: normalizeVisibleCountNumberRecord(
      input.visibleCountSwitchTargetWindowMs,
    ),
    visibleCountDrainBudgetOverrides: normalizeVisibleCountPriorityNumberRecord(
      input.visibleCountDrainBudgetOverrides,
    ),
    visibleCountDrainCandidateLimitOverrides: normalizeVisibleCountPriorityNumberRecord(
      input.visibleCountDrainCandidateLimitOverrides,
    ),
    visibilityAwareDrainBudgetOverrides: normalizeVisibilityPriorityNumberRecord(
      input.visibilityAwareDrainBudgetOverrides,
    ),
    visibilityAwareDrainCandidateLimitOverrides: normalizeVisibilityPriorityNumberRecord(
      input.visibilityAwareDrainCandidateLimitOverrides,
    ),
    writeBatchLimitOverrides: normalizePriorityNumberRecord(input.writeBatchLimitOverrides),
  };
}

function createTerminalPerformanceExperimentConfig(
  sections: TerminalPerformanceExperimentConfigSections,
): TerminalPerformanceExperimentConfig {
  return {
    ...sections.shippedPolicy,
    ...sections.exploratory,
  };
}

function normalizeExperimentConfigSections(
  input: TerminalPerformanceExperimentConfigInput | undefined,
): TerminalPerformanceExperimentConfigSections {
  if (!input) {
    return DEFAULT_TERMINAL_PERFORMANCE_EXPERIMENT_CONFIG_SECTIONS;
  }

  return {
    exploratory: normalizeExploratoryConfig(input),
    shippedPolicy: normalizeShippedPolicyConfig(input),
  };
}

function normalizeExperimentConfig(
  input: TerminalPerformanceExperimentConfigInput | undefined,
): TerminalPerformanceExperimentConfig {
  return createTerminalPerformanceExperimentConfig(normalizeExperimentConfigSections(input));
}

function getUrlNumberParam(params: URLSearchParams, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) {
      return Number(value);
    }
  }

  return undefined;
}

function getUrlStringParam(params: URLSearchParams, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) {
      return value;
    }
  }

  return undefined;
}

function readUrlExperimentConfig(): TerminalPerformanceExperimentConfigInput | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const search = window.location?.search ?? '';
  if (search === cachedUrlExperimentSearch) {
    return cachedUrlExperimentConfig;
  }

  cachedUrlExperimentSearch = search;

  const params = new URLSearchParams(search);
  const config: TerminalPerformanceExperimentConfigInput = {};
  let hasConfig = false;

  const localFeedbackMode = getUrlStringParam(params, [
    'localInputFeedbackMode',
    'terminalLocalInputFeedback',
    'terminalLocalInputFeedbackMode',
  ]);
  if (localFeedbackMode !== undefined) {
    config.localInputFeedbackMode = localFeedbackMode as TerminalLocalInputFeedbackMode;
    hasConfig = true;
  }

  const localFeedbackDurationMs = getUrlNumberParam(params, [
    'localInputFeedbackDurationMs',
    'terminalLocalInputFeedbackDurationMs',
  ]);
  if (localFeedbackDurationMs !== undefined) {
    config.localInputFeedbackDurationMs = localFeedbackDurationMs;
    hasConfig = true;
  }

  cachedUrlExperimentConfig = hasConfig ? config : undefined;
  return cachedUrlExperimentConfig;
}

function readWindowExperimentConfig(): TerminalPerformanceExperimentConfigInput | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const rawConfig = window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__;
  if (isRecord(rawConfig)) {
    return rawConfig;
  }

  return readUrlExperimentConfig();
}

function isHighLoadModeExperimentConfigEnabled(): boolean {
  return getInitialTerminalHighLoadModeEnabled();
}

function getTerminalPerformanceExperimentConfigInput(
  input: TerminalPerformanceExperimentConfigInput | undefined,
  highLoadModeEnabled: boolean,
): TerminalPerformanceExperimentConfigInput | undefined {
  if (input) {
    if (highLoadModeEnabled && input === cachedUrlExperimentConfig) {
      return {
        ...HIGH_LOAD_MODE_PRODUCT_CONFIG,
        ...input,
      };
    }

    return input;
  }

  if (highLoadModeEnabled) {
    return HIGH_LOAD_MODE_PRODUCT_CONFIG;
  }

  return undefined;
}

export function getTerminalPerformanceExperimentConfig(): TerminalPerformanceExperimentConfig {
  const nextInput = readWindowExperimentConfig();
  const nextHighLoadModeEnabled = isHighLoadModeExperimentConfigEnabled();
  if (
    nextInput === cachedExperimentConfigInput &&
    nextHighLoadModeEnabled === cachedHighLoadModeEnabled
  ) {
    return cachedExperimentConfig;
  }

  cachedExperimentConfigInput = nextInput;
  cachedHighLoadModeEnabled = nextHighLoadModeEnabled;
  cachedExperimentConfig = normalizeExperimentConfig(
    getTerminalPerformanceExperimentConfigInput(nextInput, nextHighLoadModeEnabled),
  );
  return cachedExperimentConfig;
}

export function getTerminalVisibilityDensityForVisibleCount(
  visibleTerminalCount: number,
): TerminalVisibilityDensityName {
  if (visibleTerminalCount <= 1) {
    return 'single';
  }

  if (visibleTerminalCount <= 4) {
    return 'few';
  }

  return 'dense';
}

function getDefinedNumberOverride(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function getVisibilityAwarePriorityNumberOverride(
  overrides: TerminalPerformanceVisibilityPriorityNumberRecord,
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
): number | null {
  const density = getTerminalVisibilityDensityForVisibleCount(visibleTerminalCount);
  const densityOverrides = overrides[density];
  if (!densityOverrides) {
    return null;
  }

  return getDefinedNumberOverride(densityOverrides[priority]);
}

function getVisibleCountPriorityNumberOverride(
  overrides: TerminalPerformanceVisibleCountPriorityNumberRecord,
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
): number | null {
  const visibleCountKey = getVisibleCountKey(visibleTerminalCount);
  if (visibleCountKey === null) {
    return null;
  }

  const visibleCountOverrides = overrides[visibleCountKey];
  if (!visibleCountOverrides) {
    return null;
  }

  return getDefinedNumberOverride(visibleCountOverrides[priority]);
}

function getVisibilityAwareLaneNumberOverride(
  overrides: TerminalPerformanceVisibilityLaneNumberRecord,
  lane: TerminalOutputDrainLaneName,
  visibleTerminalCount: number,
): number | null {
  const density = getTerminalVisibilityDensityForVisibleCount(visibleTerminalCount);
  const densityOverrides = overrides[density];
  if (!densityOverrides) {
    return null;
  }

  return getDefinedNumberOverride(densityOverrides[lane]);
}

function getVisibleCountLaneNumberOverride(
  overrides: TerminalPerformanceVisibleCountLaneNumberRecord,
  lane: TerminalOutputDrainLaneName,
  visibleTerminalCount: number,
): number | null {
  const visibleCountKey = getVisibleCountKey(visibleTerminalCount);
  if (visibleCountKey === null) {
    return null;
  }

  const visibleCountOverrides = overrides[visibleCountKey];
  if (!visibleCountOverrides) {
    return null;
  }

  return getDefinedNumberOverride(visibleCountOverrides[lane]);
}

function getVisibilityAwareNumberOverride(
  overrides: TerminalPerformanceVisibilityNumberRecord,
  visibleTerminalCount: number,
): number | null {
  const density = getTerminalVisibilityDensityForVisibleCount(visibleTerminalCount);
  return getDefinedNumberOverride(overrides[density]);
}

function getVisibleCountNumberOverride(
  overrides: TerminalPerformanceVisibleCountNumberRecord,
  visibleTerminalCount: number,
): number | null {
  const visibleCountKey = getVisibleCountKey(visibleTerminalCount);
  if (visibleCountKey === null) {
    return null;
  }

  return getDefinedNumberOverride(overrides[visibleCountKey]);
}

function getPressureNumberOverride(
  overrides: TerminalPerformancePressureNumberRecord,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  return getDefinedNumberOverride(overrides[pressureLevel]);
}

function getVisibleCountPressureNumberOverride(
  overrides: TerminalPerformanceVisibleCountPressureNumberRecord,
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  const visibleCountKey = getVisibleCountKey(visibleTerminalCount);
  if (visibleCountKey === null) {
    return null;
  }

  const pressureOverrides = overrides[visibleCountKey];
  if (!pressureOverrides) {
    return null;
  }

  return getPressureNumberOverride(pressureOverrides, pressureLevel);
}

function getVisibleCountPriorityPressureNumberOverride(
  overrides: TerminalPerformanceVisibleCountPriorityPressureNumberRecord,
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  const visibleCountKey = getVisibleCountKey(visibleTerminalCount);
  if (visibleCountKey === null) {
    return null;
  }

  const priorityOverrides = overrides[visibleCountKey];
  if (!priorityOverrides) {
    return null;
  }

  const pressureOverrides = priorityOverrides[priority];
  if (!pressureOverrides) {
    return null;
  }

  return getPressureNumberOverride(pressureOverrides, pressureLevel);
}

export function getTerminalExperimentDrainBudgetOverride(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountPriorityNumberOverride(
    experimentConfig.visibleCountDrainBudgetOverrides,
    priority,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  const densityOverride = getVisibilityAwarePriorityNumberOverride(
    experimentConfig.visibilityAwareDrainBudgetOverrides,
    priority,
    visibleTerminalCount,
  );
  if (densityOverride !== null) {
    return densityOverride;
  }

  return getDefinedNumberOverride(experimentConfig.drainBudgetOverrides[priority]);
}

export function getTerminalExperimentDrainCandidateLimitOverride(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountPriorityNumberOverride(
    experimentConfig.visibleCountDrainCandidateLimitOverrides,
    priority,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  const densityOverride = getVisibilityAwarePriorityNumberOverride(
    experimentConfig.visibilityAwareDrainCandidateLimitOverrides,
    priority,
    visibleTerminalCount,
  );
  if (densityOverride !== null) {
    return densityOverride;
  }

  return getDefinedNumberOverride(experimentConfig.drainCandidateLimitOverrides[priority]);
}

export function getTerminalExperimentWriteBatchLimitOverride(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountPriorityNumberOverride(
    experimentConfig.visibleCountWriteBatchLimitOverrides,
    priority,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  const densityOverride = getVisibilityAwarePriorityNumberOverride(
    experimentConfig.visibilityAwareWriteBatchLimitOverrides,
    priority,
    visibleTerminalCount,
  );
  if (densityOverride !== null) {
    return densityOverride;
  }

  return getDefinedNumberOverride(experimentConfig.writeBatchLimitOverrides[priority]);
}

export function getTerminalExperimentStartupAttachChunkByteOverride(
  priority: TerminalOutputPriorityName,
): number | null {
  return getDefinedNumberOverride(
    getTerminalPerformanceExperimentConfig().startupAttachChunkByteOverrides[priority],
  );
}

export function getTerminalExperimentStartupAttachSwitchWindowChunkByteOverride(
  priority: TerminalOutputPriorityName,
): number | null {
  return getDefinedNumberOverride(
    getTerminalPerformanceExperimentConfig().startupAttachSwitchWindowChunkByteOverrides[priority],
  );
}

export function getTerminalExperimentStartupAttachYieldOverride(
  priority: TerminalOutputPriorityName,
): boolean | null {
  const value = getTerminalPerformanceExperimentConfig().startupAttachYieldOverrides[priority];
  return typeof value === 'boolean' ? value : null;
}

export function getTerminalExperimentStartupHiddenReplayUnblockPhase(): TerminalStartupHiddenReplayUnblockPhase {
  return getTerminalPerformanceExperimentConfig().startupHiddenReplayUnblockPhase;
}

export function getTerminalExperimentStartupTaskSchedulingMode(): TerminalStartupTaskSchedulingMode {
  return getTerminalPerformanceExperimentConfig().startupTaskSchedulingMode;
}

export function shouldUseTerminalExperimentStartupTaskSchedulingRole(
  role: TerminalStartupTaskSchedulingRole,
): boolean {
  return getTerminalPerformanceExperimentConfig().startupTaskSchedulingRoles[role] === true;
}

export function getTerminalExperimentStartupVisibleSiblingSessionFitGateUntilSelectedPaintReady(): boolean {
  return getTerminalPerformanceExperimentConfig()
    .startupVisibleSiblingSessionFitGateUntilSelectedPaintReady;
}

export function getTerminalExperimentStartupSkipNonSelectedVisibleSessionRafFit(): boolean {
  return getTerminalPerformanceExperimentConfig().startupSkipNonSelectedVisibleSessionRafFit;
}

export function getTerminalExperimentStartupVisibleSiblingReplayUnblockPhase(): TerminalStartupVisibleSiblingReplayUnblockPhase {
  return getTerminalPerformanceExperimentConfig().startupVisibleSiblingReplayUnblockPhase;
}

export function getTerminalExperimentVisibleWebglAcquisitionMode(): TerminalVisibleWebglAcquisitionMode {
  return getTerminalPerformanceExperimentConfig().visibleWebglAcquisitionMode;
}

export function getTerminalExperimentVisibleWebglContextLimit(): number {
  return getTerminalPerformanceExperimentConfig().visibleWebglContextLimit;
}

export function getTerminalExperimentInputAcknowledgementMode(): TerminalInputAcknowledgementMode {
  return getTerminalPerformanceExperimentConfig().inputAcknowledgementMode;
}

export function getTerminalExperimentInputAcknowledgementDurationMs(): number {
  return getTerminalPerformanceExperimentConfig().inputAcknowledgementDurationMs;
}

export function getTerminalExperimentLocalInputFeedbackMode(): TerminalLocalInputFeedbackMode {
  return getTerminalPerformanceExperimentConfig().localInputFeedbackMode;
}

export function getTerminalExperimentLocalInputFeedbackModeOverride(): TerminalLocalInputFeedbackMode | null {
  const rawConfig = readWindowExperimentConfig();
  if (!rawConfig || rawConfig.localInputFeedbackMode === undefined) {
    return null;
  }

  return parseLocalInputFeedbackMode(rawConfig.localInputFeedbackMode);
}

export function getTerminalExperimentLocalInputFeedbackDurationMs(): number {
  return getTerminalPerformanceExperimentConfig().localInputFeedbackDurationMs;
}

export function getTerminalExperimentLaneFrameBudgetOverride(
  lane: TerminalOutputDrainLaneName,
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountLaneNumberOverride(
    experimentConfig.visibleCountLaneFrameBudgetOverrides,
    lane,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  const densityOverride = getVisibilityAwareLaneNumberOverride(
    experimentConfig.visibilityAwareLaneFrameBudgetOverrides,
    lane,
    visibleTerminalCount,
  );
  if (densityOverride !== null) {
    return densityOverride;
  }

  return getDefinedNumberOverride(experimentConfig.laneFrameBudgetOverrides[lane]);
}

export function getTerminalExperimentNonTargetVisibleFrameBudgetOverride(
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountNumberOverride(
    experimentConfig.visibleCountNonTargetVisibleFrameBudgetOverrides,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  return getVisibilityAwareNumberOverride(
    experimentConfig.visibilityAwareNonTargetVisibleFrameBudgetOverrides,
    visibleTerminalCount,
  );
}

export function getTerminalExperimentSwitchPostInputReadyEchoGraceMs(
  visibleTerminalCount: number,
): number {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountNumberOverride(
    experimentConfig.visibleCountSwitchPostInputReadyEchoGraceMs,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  return experimentConfig.switchPostInputReadyEchoGraceMs;
}

export function getTerminalExperimentSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes(
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountNumberOverride(
    experimentConfig.visibleCountSwitchPostInputReadyFirstFocusedWriteBatchLimitBytes,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  return experimentConfig.switchPostInputReadyFirstFocusedWriteBatchLimitBytes || null;
}

export function getTerminalExperimentSwitchTargetWindowMs(visibleTerminalCount: number): number {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountNumberOverride(
    experimentConfig.visibleCountSwitchTargetWindowMs,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  return experimentConfig.switchTargetWindowMs;
}

export function getTerminalExperimentSwitchTargetReserveBytes(
  visibleTerminalCount: number,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountNumberOverride(
    experimentConfig.visibleCountSwitchTargetReserveBytes,
    visibleTerminalCount,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  return getVisibilityAwareNumberOverride(
    experimentConfig.visibilityAwareSwitchTargetReserveBytes,
    visibleTerminalCount,
  );
}

export function getTerminalExperimentDenseOverloadMinimumVisibleCount(): number {
  return getTerminalPerformanceExperimentConfig().denseOverloadMinimumVisibleCount;
}

export function getTerminalExperimentDenseOverloadPressureFloor(): TerminalDenseOverloadPressureFloorName | null {
  return getTerminalPerformanceExperimentConfig().denseOverloadPressureFloor;
}

export function getTerminalExperimentDenseOverloadLaneFrameBudgetOverride(
  lane: TerminalOutputDrainLaneName,
  visibleTerminalCount: number,
): number | null {
  return getVisibleCountLaneNumberOverride(
    getTerminalPerformanceExperimentConfig().denseOverloadVisibleCountLaneFrameBudgetOverrides,
    lane,
    visibleTerminalCount,
  );
}

export function getTerminalExperimentDenseOverloadNonTargetVisibleFrameBudgetOverride(
  visibleTerminalCount: number,
): number | null {
  return getVisibleCountNumberOverride(
    getTerminalPerformanceExperimentConfig()
      .denseOverloadVisibleCountNonTargetVisibleFrameBudgetOverrides,
    visibleTerminalCount,
  );
}

export function getTerminalExperimentDenseOverloadSwitchTargetReserveBytes(
  visibleTerminalCount: number,
): number | null {
  return getVisibleCountNumberOverride(
    getTerminalPerformanceExperimentConfig().denseOverloadVisibleCountSwitchTargetReserveBytes,
    visibleTerminalCount,
  );
}

export function getTerminalExperimentDenseOverloadWriteBatchLimitOverride(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
): number | null {
  return getVisibleCountPriorityNumberOverride(
    getTerminalPerformanceExperimentConfig().denseOverloadVisibleCountWriteBatchLimitOverrides,
    priority,
    visibleTerminalCount,
  );
}

export function getTerminalExperimentDenseOverloadPressureDrainBudgetScale(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  return getVisibleCountPriorityPressureNumberOverride(
    getTerminalPerformanceExperimentConfig().denseOverloadVisibleCountPressureDrainBudgetScales,
    priority,
    visibleTerminalCount,
    pressureLevel,
  );
}

export function getTerminalExperimentDenseOverloadPressureWriteBatchLimitScale(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  return getVisibleCountPriorityPressureNumberOverride(
    getTerminalPerformanceExperimentConfig().denseOverloadVisibleCountPressureWriteBatchLimitScales,
    priority,
    visibleTerminalCount,
    pressureLevel,
  );
}

export function hasTerminalFramePressureResponsiveExperimentConfig(): boolean {
  return (
    hasTerminalDenseOverloadExperimentConfig() ||
    hasTerminalNonDenseFramePressureResponsiveExperimentConfig()
  );
}

export function hasTerminalDenseOverloadExperimentConfig(): boolean {
  return getTerminalPerformanceExperimentConfig().denseOverloadMinimumVisibleCount > 0;
}

export function hasTerminalNonDenseFramePressureResponsiveExperimentConfig(): boolean {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  return (
    experimentConfig.adaptiveActiveVisibleThrottleMode !== 'off' ||
    experimentConfig.adaptiveVisibleBackgroundThrottleMode !== 'off' ||
    Object.keys(experimentConfig.visibleCountPressureDrainBudgetScales).length > 0 ||
    Object.keys(experimentConfig.visibleCountPressureNonTargetVisibleFrameBudgetScales).length >
      0 ||
    Object.keys(experimentConfig.visibleCountPressureWriteBatchLimitScales).length > 0 ||
    Object.keys(experimentConfig.multiVisiblePressureNonTargetVisibleFrameBudgetScales).length >
      0 ||
    Object.keys(experimentConfig.multiVisiblePressureWriteBatchLimitScales).length > 0
  );
}

export function getTerminalExperimentVisibleCountPressureDrainBudgetScale(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  return getVisibleCountPriorityPressureNumberOverride(
    experimentConfig.visibleCountPressureDrainBudgetScales,
    priority,
    visibleTerminalCount,
    pressureLevel,
  );
}

export function getTerminalExperimentMultiVisiblePressureNonTargetVisibleFrameBudgetScale(
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountPressureNumberOverride(
    experimentConfig.visibleCountPressureNonTargetVisibleFrameBudgetScales,
    visibleTerminalCount,
    pressureLevel,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  if (visibleTerminalCount < experimentConfig.multiVisiblePressureMinimumVisibleCount) {
    return null;
  }

  return getPressureNumberOverride(
    experimentConfig.multiVisiblePressureNonTargetVisibleFrameBudgetScales,
    pressureLevel,
  );
}

export function getTerminalExperimentMultiVisiblePressureWriteBatchLimitScale(
  priority: TerminalOutputPriorityName,
  visibleTerminalCount: number,
  pressureLevel: TerminalFramePressureLevelName,
): number | null {
  const experimentConfig = getTerminalPerformanceExperimentConfig();
  const visibleCountOverride = getVisibleCountPriorityPressureNumberOverride(
    experimentConfig.visibleCountPressureWriteBatchLimitScales,
    priority,
    visibleTerminalCount,
    pressureLevel,
  );
  if (visibleCountOverride !== null) {
    return visibleCountOverride;
  }

  if (visibleTerminalCount < experimentConfig.multiVisiblePressureMinimumVisibleCount) {
    return null;
  }

  const priorityOverrides = experimentConfig.multiVisiblePressureWriteBatchLimitScales[priority];
  if (!priorityOverrides) {
    return null;
  }

  return getPressureNumberOverride(priorityOverrides, pressureLevel);
}

export function resetTerminalPerformanceExperimentConfigForTests(): void {
  cachedExperimentConfigInput = Symbol('reset-terminal-performance-config');
  cachedExperimentConfig = DEFAULT_TERMINAL_PERFORMANCE_EXPERIMENT_CONFIG;
  cachedHighLoadModeEnabled = false;
  cachedUrlExperimentSearch = null;
  cachedUrlExperimentConfig = undefined;
}
