type StandaloneServerErrorListener = (error: Error) => void;
type StandaloneServerExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type StandaloneServerOutputListener = (chunk: Uint8Array | string) => void;

export interface StandaloneServerOutput {
  off(event: 'data', listener: StandaloneServerOutputListener): this;
  on(event: 'data', listener: StandaloneServerOutputListener): this;
}

export interface StandaloneServerLifecycleProcess {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  off(event: 'error', listener: StandaloneServerErrorListener): this;
  off(event: 'exit', listener: StandaloneServerExitListener): this;
  on(event: 'error', listener: StandaloneServerErrorListener): this;
  on(event: 'exit', listener: StandaloneServerExitListener): this;
  once(event: 'error', listener: StandaloneServerErrorListener): this;
  once(event: 'exit', listener: StandaloneServerExitListener): this;
  readonly pid?: number | undefined;
  readonly signalCode: NodeJS.Signals | null;
}

export interface StandaloneServerProcess extends StandaloneServerLifecycleProcess {
  readonly stderr: StandaloneServerOutput;
  readonly stdout: StandaloneServerOutput;
}

export interface StandaloneServerReadyResult {
  baseUrl: string;
  port: number;
  url: string;
}

export interface WaitForStandaloneServerReadyOptions {
  onStderr?: (text: string) => void;
  outputBufferMaxChars?: number;
  timeoutMs?: number;
}

export interface StopStandaloneServerProcessOptions {
  forceKillAfterMs?: number;
  forceKillSettleMs?: number;
}

export const spawnStandaloneServerProcess: typeof import('node:child_process').spawn;

export function parseStandaloneServerReadyOutput(
  output: string,
): StandaloneServerReadyResult | null;

export function waitForStandaloneServerReady(
  serverProcess: StandaloneServerProcess,
  options?: WaitForStandaloneServerReadyOptions,
): Promise<StandaloneServerReadyResult>;

export function stopStandaloneServerProcess(
  serverProcess: StandaloneServerLifecycleProcess,
  options?: StopStandaloneServerProcessOptions,
): Promise<void>;

export function stopStandaloneServerProcessWithRetry(
  serverProcess: StandaloneServerLifecycleProcess,
  options?: StopStandaloneServerProcessOptions,
): Promise<void>;

export function getDevelopmentStateDir(userDataPath: string): string;

export function cleanupDevelopmentServerData(
  userDataPath: string,
  dependencies?: {
    remove?: (path: string, options: { force: boolean; recursive: boolean }) => Promise<void>;
  },
): Promise<void>;
