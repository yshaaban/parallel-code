const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export interface DirectCommandInvocation {
  args: string[];
  command: string;
  env?: Record<string, string>;
}

export interface DirectCommandParseError {
  message: string;
  reason: 'empty' | 'unterminated';
}

export type DirectCommandParseResult =
  | {
      invocation: DirectCommandInvocation;
      ok: true;
    }
  | {
      error: DirectCommandParseError;
      ok: false;
    };

function pushCommandToken(tokens: string[], currentToken: string, tokenStarted: boolean): void {
  if (tokenStarted) {
    tokens.push(currentToken);
  }
}

function tokenizeDirectCommand(commandLine: string): string[] | null {
  const tokens: string[] = [];
  let currentToken = '';
  let escaped = false;
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine.charAt(index);

    if (escaped) {
      currentToken += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (character === '\\' && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        currentToken += character;
        tokenStarted = true;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      pushCommandToken(tokens, currentToken, tokenStarted);
      currentToken = '';
      tokenStarted = false;
      continue;
    }

    currentToken += character;
    tokenStarted = true;
  }

  if (escaped || quote !== null) {
    return null;
  }

  pushCommandToken(tokens, currentToken, tokenStarted);
  return tokens;
}

function splitLeadingEnvironment(tokens: string[]): {
  args: string[];
  command: string | null;
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  let commandIndex = 0;

  if (tokens[0] === 'env') {
    commandIndex = 1;
  }

  while (commandIndex < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[commandIndex] ?? '')) {
    const token = tokens[commandIndex] ?? '';
    const separatorIndex = token.indexOf('=');
    env[token.slice(0, separatorIndex)] = token.slice(separatorIndex + 1);
    commandIndex += 1;
  }

  const command = tokens[commandIndex] ?? null;
  return {
    args: command === null ? [] : tokens.slice(commandIndex + 1),
    command,
    env,
  };
}

export function parseDirectCommandLine(commandLine: string): DirectCommandParseResult {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return {
      error: {
        message: 'Command must not be empty.',
        reason: 'empty',
      },
      ok: false,
    };
  }

  const tokens = tokenizeDirectCommand(trimmed);
  if (!tokens || tokens.length === 0) {
    return {
      error: {
        message: 'Command has an unterminated quote or escape.',
        reason: 'unterminated',
      },
      ok: false,
    };
  }

  const invocation = splitLeadingEnvironment(tokens);
  if (invocation.command === null) {
    return {
      error: {
        message: 'Command must include an executable.',
        reason: 'empty',
      },
      ok: false,
    };
  }

  return {
    invocation: {
      args: invocation.args,
      command: invocation.command,
      ...(Object.keys(invocation.env).length > 0 ? { env: invocation.env } : {}),
    },
    ok: true,
  };
}
