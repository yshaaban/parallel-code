const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_WRAPPER_COMMANDS = new Set([
  'bash',
  'cmd',
  'dash',
  'fish',
  'ksh',
  'pwsh',
  'powershell',
  'sh',
  'zsh',
]);
const UNSUPPORTED_COMMAND_TEMPLATE_MESSAGE =
  'Arena competitor commands must be direct executable invocations. Shell wrappers and environment prefixes are not supported.';

export interface ArenaCommandInvocation {
  args: string[];
  command: string;
}

export interface ArenaCommandTemplateParseError {
  message: string;
  reason: 'empty' | 'unsupported';
}

export type ArenaCommandTemplateParseResult =
  | {
      invocation: ArenaCommandInvocation;
      ok: true;
    }
  | {
      error: ArenaCommandTemplateParseError;
      ok: false;
    };

function pushCommandTemplateToken(
  tokens: string[],
  currentToken: string,
  tokenStarted: boolean,
): void {
  if (tokenStarted) {
    tokens.push(currentToken);
  }
}

function tokenizeArenaCommandTemplate(commandTemplate: string): string[] | null {
  const tokens: string[] = [];
  let currentToken = '';
  let escaped = false;
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < commandTemplate.length; index += 1) {
    const character = commandTemplate.charAt(index);

    if (escaped) {
      currentToken += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (character === '\\') {
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
      pushCommandTemplateToken(tokens, currentToken, tokenStarted);
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

  pushCommandTemplateToken(tokens, currentToken, tokenStarted);
  return tokens;
}

function isEnvironmentAssignment(token: string): boolean {
  return ENV_ASSIGNMENT_PATTERN.test(token);
}

function isShellWrapperCommand(command: string): boolean {
  return SHELL_WRAPPER_COMMANDS.has(command.toLowerCase());
}

function replacePromptTokens(template: string, prompt: string): string {
  return template.replace(/\{prompt\}/g, prompt);
}

export function parseArenaCommandTemplate(
  commandTemplate: string,
): ArenaCommandTemplateParseResult {
  const trimmedTemplate = commandTemplate.trim();
  if (trimmedTemplate.length === 0) {
    return {
      error: {
        message: 'Competitor command must not be empty.',
        reason: 'empty',
      },
      ok: false,
    };
  }

  const tokens = tokenizeArenaCommandTemplate(trimmedTemplate);
  if (!tokens || tokens.length === 0) {
    return {
      error: {
        message: UNSUPPORTED_COMMAND_TEMPLATE_MESSAGE,
        reason: 'unsupported',
      },
      ok: false,
    };
  }

  const [command, ...args] = tokens;
  if (command === undefined) {
    return {
      error: {
        message: UNSUPPORTED_COMMAND_TEMPLATE_MESSAGE,
        reason: 'unsupported',
      },
      ok: false,
    };
  }

  if (isEnvironmentAssignment(command) || command === 'env' || isShellWrapperCommand(command)) {
    return {
      error: {
        message: UNSUPPORTED_COMMAND_TEMPLATE_MESSAGE,
        reason: 'unsupported',
      },
      ok: false,
    };
  }

  if (command.includes('{prompt}')) {
    return {
      error: {
        message:
          'Arena competitor commands must keep {prompt} in an argument, not in the executable name.',
        reason: 'unsupported',
      },
      ok: false,
    };
  }

  return {
    invocation: {
      args,
      command,
    },
    ok: true,
  };
}

export function materializeArenaCommandInvocation(
  commandTemplate: string,
  prompt: string,
): ArenaCommandInvocation {
  const parsedTemplate = parseArenaCommandTemplate(commandTemplate);
  if (!parsedTemplate.ok) {
    throw new Error(parsedTemplate.error.message);
  }

  return {
    args: parsedTemplate.invocation.args.map((arg) => replacePromptTokens(arg, prompt)),
    command: replacePromptTokens(parsedTemplate.invocation.command, prompt),
  };
}
