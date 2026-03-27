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
