/**
 * Parse Claude Code (and other agent) permission prompts from PTY output.
 * Returns a structured PermissionRequest when a complete prompt is detected.
 */

export interface ParsedPermission {
  tool: string;
  description: string;
  arguments: string;
}

// Claude Code permission prompt patterns
const CLAUDE_TOOL_RE = /(?:Tool|Action|Allow tool):\s+(\w+)/i;
const CLAUDE_ARGS_PATTERNS = [
  /(?:File|Path):\s+(.+)/,
  /(?:Command):\s+(.+)/,
  /(?:Content):\s+(.+)/,
];
const PERMISSION_PROMPT_RE =
  /(?:Do you want to (?:allow|run|execute)|Allow (?:tool|action)|wants? to use|Permission requested)/i;
const APPROVE_DENY_RE = /\(y\/n\)|\[Y\/n\]|\[y\/N\]|approve|deny|allow|reject/i;

/**
 * Buffer for accumulating partial output until a complete permission prompt
 * is detected. Create one per agent.
 */
export class PermissionBuffer {
  private buffer = '';
  private readonly maxSize = 4096;

  /** Feed new output data. Returns a ParsedPermission if a complete prompt is detected. */
  feed(data: string): ParsedPermission | null {
    this.buffer += data;

    // Keep buffer bounded
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }

    const result = parsePermissionPrompt(this.buffer);
    if (result) {
      this.buffer = '';
    }
    return result;
  }

  /** Reset the buffer (e.g., after user approves/denies). */
  reset(): void {
    this.buffer = '';
  }
}

/** Try to parse a complete permission prompt from accumulated text. */
export function parsePermissionPrompt(text: string): ParsedPermission | null {
  // Must contain a permission indicator AND an approve/deny prompt
  if (!PERMISSION_PROMPT_RE.test(text) || !APPROVE_DENY_RE.test(text)) {
    return null;
  }

  // Extract tool name
  const toolMatch = text.match(CLAUDE_TOOL_RE);
  const tool = toolMatch ? toolMatch[1] : 'Unknown';

  // Extract arguments from various patterns
  let args = '';
  for (const pattern of CLAUDE_ARGS_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      args = match[1].trim();
      break;
    }
  }

  // Build description from the prompt text (first meaningful line)
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const descLine = lines.find((l) => PERMISSION_PROMPT_RE.test(l)) ?? lines[0] ?? '';
  const description = descLine.trim().slice(0, 200);

  return { tool, description, arguments: args };
}
