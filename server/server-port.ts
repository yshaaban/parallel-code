const DEFAULT_SERVER_PORT = 3000;
const MIN_SERVER_PORT = 0;
const MAX_SERVER_PORT = 65_535;
const INTEGER_PATTERN = /^\d+$/u;

export function getServerPort(env: NodeJS.ProcessEnv): number {
  const value = env.PORT?.trim();
  if (!value) {
    return DEFAULT_SERVER_PORT;
  }

  if (!INTEGER_PATTERN.test(value)) {
    return DEFAULT_SERVER_PORT;
  }

  const parsed = Number(value);
  if (parsed < MIN_SERVER_PORT || parsed > MAX_SERVER_PORT) {
    return DEFAULT_SERVER_PORT;
  }

  return parsed;
}
