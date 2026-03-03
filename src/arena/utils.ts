/** Format milliseconds as a human-readable duration */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    // Handle toFixed(1) rounding 59.95+ to "60.0"
    const fixed = seconds.toFixed(1);
    if (fixed === '60.0') return '1m 0.0s';
    return `${fixed}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const secsFixed = secs.toFixed(1);
  // Handle toFixed(1) rounding 59.95+ to "60.0"
  if (secsFixed === '60.0') return `${mins + 1}m 0.0s`;
  return `${mins}m ${secsFixed}s`;
}
