const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Read the current preference once when an appearance animation is created. */
export function shouldAnimateTaskAppearance(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }

  try {
    return !window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return true;
  }
}
