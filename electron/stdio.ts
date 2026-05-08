interface ErrorStream {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
}

interface InstallStdioEpipeGuardDeps {
  stderr?: ErrorStream;
  stdout?: ErrorStream;
}

let installedOnProcessStreams = false;

export function handleStdioPipeError(error: NodeJS.ErrnoException): void {
  if (error.code === 'EPIPE') {
    return;
  }

  throw error;
}

export function installStdioEpipeGuard(deps: InstallStdioEpipeGuardDeps = {}): void {
  if (!deps.stdout && !deps.stderr) {
    if (installedOnProcessStreams) {
      return;
    }
    installedOnProcessStreams = true;
  }

  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  stdout.on('error', handleStdioPipeError);
  stderr.on('error', handleStdioPipeError);
}
