import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDef } from '../../../src/ipc/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'scripts', 'fixtures');

export interface BrowserLabScenario {
  agentDef: AgentDef;
  name: string;
  taskName: string;
}

function createAgentDef(id: string, name: string, command: string, args: string[]): AgentDef {
  return {
    id,
    name,
    command,
    args,
    resume_args: [],
    skip_permissions_args: [],
    description: `${name} browser-lab fixture`,
  };
}

function getFixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

export function createPromptReadyScenario(delayMs = 220): BrowserLabScenario {
  return {
    name: 'prompt-ready',
    taskName: 'Prompt Ready Fixture',
    agentDef: createAgentDef(
      'browser-lab-prompt-ready',
      'Browser Lab Prompt Ready',
      process.execPath,
      [getFixturePath('tui-prompt-ready.mjs'), String(delayMs)],
    ),
  };
}

export function createInteractiveNodeScenario(): BrowserLabScenario {
  return {
    name: 'interactive-node',
    taskName: 'Interactive Node Fixture',
    agentDef: createAgentDef('browser-lab-node', 'Browser Lab Node REPL', process.execPath, []),
  };
}

export function createWrapScenario(repeatCount = 2, lineWidth = 160): BrowserLabScenario {
  return {
    name: 'wrap-fixture',
    taskName: 'Wrap Fixture',
    agentDef: createAgentDef('browser-lab-wrap', 'Browser Lab Wrap', process.execPath, [
      getFixturePath('tui-wrap.mjs'),
      String(repeatCount),
      String(lineWidth),
    ]),
  };
}

export function createStatuslineScenario(frameCount = 80, delayMs = 25): BrowserLabScenario {
  return {
    name: 'statusline-fixture',
    taskName: 'Statusline Fixture',
    agentDef: createAgentDef('browser-lab-statusline', 'Browser Lab Statusline', process.execPath, [
      getFixturePath('tui-statusline.mjs'),
      String(frameCount),
      String(delayMs),
    ]),
  };
}
