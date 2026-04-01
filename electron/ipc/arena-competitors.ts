import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import type {
  ArenaCompetitorInspectIssue,
  ArenaCompetitorInspectResult,
} from '../../src/ipc/types.js';
import { isCommandAvailable } from './command-resolver.js';

const execFileAsync = promisify(execFile);
const COMMAND_PROBE_TIMEOUT_MS = 5_000;
const QUIET_EXECUTION_COMMANDS = new Set(['claude', 'codex']);

interface CommandProbeResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

type CommandProbe = (command: string, args: string[]) => Promise<CommandProbeResult>;

interface ArenaCompetitorInspectorOptions {
  env?: NodeJS.ProcessEnv;
  isCommandAvailable?: (command: string) => Promise<boolean>;
  probeCommand?: CommandProbe;
}

function createIssue(
  code: ArenaCompetitorInspectIssue['code'],
  message: string,
  severity: ArenaCompetitorInspectIssue['severity'],
): ArenaCompetitorInspectIssue {
  return {
    code,
    message,
    severity,
  };
}

function getExecutableFromCommandTemplate(commandTemplate: string): string | null {
  const trimmed = commandTemplate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closingQuoteIndex = trimmed.indexOf(quote, 1);
    if (closingQuoteIndex <= 0) {
      return null;
    }
    return trimmed.slice(1, closingQuoteIndex);
  }

  const separatorIndex = trimmed.search(/\s/);
  if (separatorIndex < 0) {
    return trimmed;
  }

  return trimmed.slice(0, separatorIndex);
}

function getExecutableBasename(executable: string): string {
  return path.basename(executable).toLowerCase();
}

async function runCommandProbe(command: string, args: string[]): Promise<CommandProbeResult> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: COMMAND_PROBE_TIMEOUT_MS,
    });
    return {
      ok: true,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    };
  } catch (error) {
    const failedProbe = error as { stderr?: string; stdout?: string };
    return {
      ok: false,
      stderr: failedProbe.stderr ?? '',
      stdout: failedProbe.stdout ?? '',
    };
  }
}

async function hasClaudeAuthentication(
  env: NodeJS.ProcessEnv,
  probeCommand: CommandProbe,
): Promise<boolean> {
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return true;
  }

  const result = await probeCommand('claude', ['auth', 'status']);
  if (!result.ok) {
    return false;
  }

  return /logged in|authenticated/i.test(`${result.stdout}\n${result.stderr}`);
}

async function hasCodexAuthentication(
  env: NodeJS.ProcessEnv,
  probeCommand: CommandProbe,
): Promise<boolean> {
  if (env.OPENAI_API_KEY?.trim()) {
    return true;
  }

  const result = await probeCommand('codex', ['login', 'status']);
  return result.ok;
}

async function getAuthenticationIssue(
  executableBasename: string,
  env: NodeJS.ProcessEnv,
  probeCommand: CommandProbe,
): Promise<ArenaCompetitorInspectIssue | null> {
  switch (executableBasename) {
    case 'gemini':
      if (env.GEMINI_API_KEY?.trim()) {
        return null;
      }
      return createIssue(
        'missing_gemini_api_key',
        'Gemini requires GEMINI_API_KEY in the app/server environment.',
        'error',
      );
    case 'claude':
      if (await hasClaudeAuthentication(env, probeCommand)) {
        return null;
      }
      return createIssue(
        'missing_claude_auth',
        'Claude is not authenticated for this app/server runtime.',
        'error',
      );
    case 'codex':
      if (await hasCodexAuthentication(env, probeCommand)) {
        return null;
      }
      return createIssue(
        'missing_codex_auth',
        'Codex is not authenticated for this app/server runtime.',
        'error',
      );
    default:
      return null;
  }
}

function getQuietExecutionWarning(executableBasename: string): ArenaCompetitorInspectIssue | null {
  if (!QUIET_EXECUTION_COMMANDS.has(executableBasename)) {
    return null;
  }

  return createIssue(
    'quiet_noninteractive_output',
    'This CLI can stay quiet until it finishes even when it is still working.',
    'warning',
  );
}

export async function inspectArenaCompetitor(
  commandTemplate: string,
  options: ArenaCompetitorInspectorOptions = {},
): Promise<ArenaCompetitorInspectResult> {
  const executable = getExecutableFromCommandTemplate(commandTemplate);
  if (!executable) {
    return {
      executable: null,
      issues: [
        createIssue('invalid_empty_command', 'Competitor command must not be empty.', 'error'),
      ],
      status: 'invalid_command',
    };
  }

  const commandAvailable = options.isCommandAvailable ?? isCommandAvailable;
  if (!(await commandAvailable(executable))) {
    return {
      executable,
      issues: [createIssue('missing_command', `Command not found: ${executable}`, 'error')],
      status: 'missing_command',
    };
  }

  const env = options.env ?? process.env;
  const probeCommand = options.probeCommand ?? runCommandProbe;
  const executableBasename = getExecutableBasename(executable);
  const authenticationIssue = await getAuthenticationIssue(executableBasename, env, probeCommand);
  if (authenticationIssue) {
    return {
      executable,
      issues: [authenticationIssue],
      status: 'missing_auth',
    };
  }

  const quietExecutionWarning = getQuietExecutionWarning(executableBasename);
  return {
    executable,
    issues: quietExecutionWarning ? [quietExecutionWarning] : [],
    status: 'ready',
  };
}
