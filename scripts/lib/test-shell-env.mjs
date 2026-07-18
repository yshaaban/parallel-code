import path from 'node:path';

export const TEST_SHELL_HOME_DIRECTORY_NAME = 'shell-home';
export const TEST_SHELL_HOME_ENV_KEY = 'PARALLEL_CODE_TEST_SHELL_HOME';

export function getTestShellHomePath(userDataPath) {
  return path.resolve(userDataPath, TEST_SHELL_HOME_DIRECTORY_NAME);
}

export function createTestShellEnv(userDataPath) {
  return {
    [TEST_SHELL_HOME_ENV_KEY]: getTestShellHomePath(userDataPath),
  };
}
