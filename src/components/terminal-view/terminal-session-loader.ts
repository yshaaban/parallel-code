import type { StartTerminalSessionOptions, TerminalSession } from './terminal-session';
import { emitStartupBreadcrumb } from '../../app/startup-breadcrumbs';
import type { PtyOutput } from '../../ipc/types';
import { Channel } from '../../lib/ipc';

type TerminalSessionModule = typeof import('./terminal-session');

let terminalSessionModule: TerminalSessionModule | undefined;
let terminalSessionModulePromise: Promise<TerminalSessionModule> | undefined;

export function loadTerminalSessionModule(): Promise<TerminalSessionModule> {
  if (terminalSessionModule) {
    return Promise.resolve(terminalSessionModule);
  }

  if (!terminalSessionModulePromise) {
    emitStartupBreadcrumb('terminal-session:module-load-start');
    terminalSessionModulePromise = import('./terminal-session')
      .then((module) => {
        terminalSessionModule = module;
        emitStartupBreadcrumb('terminal-session:module-loaded');
        return module;
      })
      .catch((error: unknown) => {
        terminalSessionModulePromise = undefined;
        emitStartupBreadcrumb('terminal-session:module-load-failed');
        throw error;
      });
  }

  return terminalSessionModulePromise;
}

export function preloadTerminalSessionModule(): void {
  void loadTerminalSessionModule().catch((error: unknown) => {
    console.warn('Failed to preload terminal runtime:', error);
  });
}

export function startLoadedTerminalSession(
  options: StartTerminalSessionOptions,
): Promise<TerminalSession> | TerminalSession {
  emitStartupBreadcrumb('terminal-session:start-request');
  if (terminalSessionModule) {
    emitStartupBreadcrumb('terminal-session:start-immediate');
    return terminalSessionModule.startTerminalSession(options);
  }

  const outputChannel = new Channel<PtyOutput>();
  return loadTerminalSessionModule()
    .then((module) => {
      emitStartupBreadcrumb('terminal-session:start-after-load');
      return module.startTerminalSession({
        ...options,
        outputChannel,
      });
    })
    .catch((error: unknown) => {
      outputChannel.dispose();
      throw error;
    });
}
