export const DEFAULT_TERMINAL_UI_FLUIDITY_GATE_PROFILES = Object.freeze([
  'recent_hidden_switch',
  'interactive_verbose',
  'bulk_text',
]);

export const DEFAULT_TERMINAL_UI_FLUIDITY_GATE_VISIBLE_TERMINAL_COUNTS = Object.freeze([1, 2, 4]);
export const DEFAULT_TERMINAL_UI_FLUIDITY_MATRIX_GATE_VARIANTS = Object.freeze([
  'product_default',
  'high_load_mode_product',
]);
export const DEFAULT_TERMINAL_UI_FLUIDITY_DENSE_GATE_VISIBLE_TERMINAL_COUNTS = Object.freeze([4]);
export const DEFAULT_TERMINAL_UI_FLUIDITY_HIDDEN_RENDER_WAKE_VARIANT = 'hidden_hibernation';
export const DEFAULT_TERMINAL_UI_FLUIDITY_HIDDEN_SESSION_WAKE_VARIANT = 'hidden_session_dormancy';
export const DEFAULT_TERMINAL_UI_FLUIDITY_HIDDEN_SWITCH_VARIANT = 'high_load_mode_product';
export const DEFAULT_TERMINAL_UI_FLUIDITY_GATE_BUDGETS = Object.freeze({
  focusedRoundTripP95Ms: 500,
  focusedRoundTripTimeouts: 0,
  frameGapP95Ms: 160,
  hiddenQueueAgeP95Ms: 2_000,
  hiddenSwitchInputReadyMs: 250,
  longTasksTotalMs: 3_000,
  terminalRenderP95Ms: 5_000,
});

function copyReadonlyList(values) {
  return [...values];
}

function formatReadonlyList(values) {
  return values.join(',');
}

export function getDefaultTerminalUiFluidityGateProfiles() {
  return copyReadonlyList(DEFAULT_TERMINAL_UI_FLUIDITY_GATE_PROFILES);
}

export function getDefaultTerminalUiFluidityGateVisibleTerminalCounts() {
  return copyReadonlyList(DEFAULT_TERMINAL_UI_FLUIDITY_GATE_VISIBLE_TERMINAL_COUNTS);
}

export function formatTerminalUiFluidityGateProfiles() {
  return formatReadonlyList(DEFAULT_TERMINAL_UI_FLUIDITY_GATE_PROFILES);
}

export function formatTerminalUiFluidityGateVisibleTerminalCounts() {
  return formatReadonlyList(DEFAULT_TERMINAL_UI_FLUIDITY_GATE_VISIBLE_TERMINAL_COUNTS);
}

export function formatTerminalUiFluidityMatrixGateVariants() {
  return formatReadonlyList(DEFAULT_TERMINAL_UI_FLUIDITY_MATRIX_GATE_VARIANTS);
}

export function formatTerminalUiFluidityDenseGateVisibleTerminalCounts() {
  return formatReadonlyList(DEFAULT_TERMINAL_UI_FLUIDITY_DENSE_GATE_VISIBLE_TERMINAL_COUNTS);
}

function isMeasuredDuration(value) {
  return Number.isFinite(value) && value >= 0;
}

function createBudgetCheck(context, metric, actualMs, maxMs, unit = 'ms') {
  return {
    ...context,
    actualMs,
    maxMs,
    metric,
    status: actualMs <= maxMs ? 'pass' : 'provisional-fail',
    unit,
  };
}

function addMeasuredBudgetCheck(checks, context, metric, actualMs, maxMs) {
  if (!isMeasuredDuration(actualMs)) {
    return;
  }

  checks.push(createBudgetCheck(context, metric, actualMs, maxMs));
}

function addCountBudgetCheck(checks, context, metric, actualCount, maxCount) {
  if (!Number.isFinite(actualCount) || actualCount < 0) {
    return;
  }

  checks.push(createBudgetCheck(context, metric, actualCount, maxCount, 'count'));
}

function getBudgetOverallStatus(checkedCount, failedCount) {
  if (checkedCount === 0) {
    return 'unbudgeted';
  }

  if (failedCount === 0) {
    return 'pass';
  }

  return 'provisional-fail';
}

export function evaluateTerminalUiFluidityBudgets(
  summary,
  budgets = DEFAULT_TERMINAL_UI_FLUIDITY_GATE_BUDGETS,
) {
  const checks = [];

  for (const run of summary.aggregatedRuns ?? []) {
    for (const suite of run.suites ?? []) {
      const context = {
        profile: suite.profile,
        surface: run.surface,
        terminals: run.terminals,
        variant: run.variant,
        visibleTerminalCount: run.visibleTerminalCount,
      };

      addMeasuredBudgetCheck(
        checks,
        context,
        'frame-gap p95',
        suite.frameGap?.p95Ms,
        budgets.frameGapP95Ms,
      );
      addMeasuredBudgetCheck(
        checks,
        context,
        'long tasks total',
        suite.longTasks?.totalDurationMs,
        budgets.longTasksTotalMs,
      );
      addMeasuredBudgetCheck(
        checks,
        context,
        'terminal render p95',
        suite.terminalRender?.p95Ms,
        budgets.terminalRenderP95Ms,
      );
      addMeasuredBudgetCheck(
        checks,
        context,
        'hidden queue age p95',
        suite.terminalOutputPerFrame?.hiddenQueueAgeP95Ms,
        budgets.hiddenQueueAgeP95Ms,
      );

      if (suite.profile !== 'bulk_text') {
        addCountBudgetCheck(
          checks,
          context,
          'focused roundtrip timeouts',
          suite.focusedRoundTrip?.timeoutCount,
          budgets.focusedRoundTripTimeouts,
        );
        addMeasuredBudgetCheck(
          checks,
          context,
          'focused roundtrip p95',
          suite.focusedRoundTrip?.p95Ms,
          budgets.focusedRoundTripP95Ms,
        );
      }

      if (suite.switchWake) {
        addMeasuredBudgetCheck(
          checks,
          context,
          'hidden switch input ready',
          suite.switchWake.inputReadyMs,
          budgets.hiddenSwitchInputReadyMs,
        );
      }
    }
  }

  const failedChecks = checks.filter((check) => check.status === 'provisional-fail');
  const overallStatus = getBudgetOverallStatus(checks.length, failedChecks.length);

  return {
    budgets,
    checkedCount: checks.length,
    failedChecks,
    failedCount: failedChecks.length,
    overallStatus,
  };
}
