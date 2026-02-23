import { createStore } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type {
  ArenaStore,
  ArenaPhase,
  ArenaCompetitor,
  ArenaPreset,
  ArenaMatch,
  BattleCompetitor,
} from './types';

const MAX_COMPETITORS = 4;
const MIN_COMPETITORS = 2;

function makeEmptyCompetitor(): ArenaCompetitor {
  return { id: crypto.randomUUID(), name: '', command: '' };
}

const [state, setState] = createStore<ArenaStore>({
  phase: 'config',
  competitors: [makeEmptyCompetitor(), makeEmptyCompetitor()],
  prompt: '',
  cwd: '',
  presets: [],
  history: [],
  battle: [],
  selectedHistoryMatch: null,
});

/** Read-only access to the arena store */
export const arenaStore = state;

// --- Phase ---

export function setPhase(phase: ArenaPhase): void {
  setState('phase', phase);
}

// --- Competitors ---

export function updateCompetitor(
  id: string,
  update: Partial<Pick<ArenaCompetitor, 'name' | 'command'>>,
): void {
  setState(
    'competitors',
    (c) => c.id === id,
    (prev) => ({ ...prev, ...update }),
  );
}

export function addCompetitor(): void {
  if (state.competitors.length >= MAX_COMPETITORS) return;
  setState('competitors', (prev) => [...prev, makeEmptyCompetitor()]);
}

export function removeCompetitor(id: string): void {
  if (state.competitors.length <= MIN_COMPETITORS) return;
  setState('competitors', (prev) => prev.filter((c) => c.id !== id));
}

// --- Prompt ---

export function setPrompt(prompt: string): void {
  setState('prompt', prompt);
}

export function setCwd(cwd: string): void {
  setState('cwd', cwd);
}

// --- Battle ---

export function startBattle(competitors: BattleCompetitor[]): void {
  setState('battle', competitors);
  setState('phase', 'countdown');
}

export function markBattleCompetitorExited(agentId: string, exitCode: number | null): void {
  setState(
    'battle',
    (c) => c.agentId === agentId,
    (prev) => ({
      ...prev,
      status: 'exited' as const,
      endTime: Date.now(),
      exitCode,
    }),
  );
}

export function allBattleFinished(): boolean {
  return state.battle.length > 0 && state.battle.every((c) => c.status === 'exited');
}

// --- Terminal output ---

export function setTerminalOutput(competitorId: string, output: string): void {
  setState('battle', (c) => c.id === competitorId, 'terminalOutput', output);
}

// --- Merge ---

export function markBranchMerged(competitorId: string): void {
  setState('battle', (c) => c.id === competitorId, 'merged', true);
}

// --- Worktree cleanup ---

export async function cleanupBattleWorktrees(): Promise<void> {
  if (!state.cwd) return;
  for (const c of state.battle) {
    // Skip already-merged competitors — mergeTask with cleanup:true already removed the worktree/branch
    if (c.branchName && !c.merged) {
      try {
        await invoke(IPC.RemoveArenaWorktree, {
          projectRoot: state.cwd,
          branchName: c.branchName,
        });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// --- History ---

export function addMatchToHistory(match: ArenaMatch): void {
  setState('history', (prev) => [match, ...prev]);
}

export function setSelectedHistoryMatch(match: ArenaMatch | null): void {
  setState('selectedHistoryMatch', match);
}

// --- Presets ---

export function loadPresets(presets: ArenaPreset[]): void {
  setState('presets', presets);
}

export function loadHistory(history: ArenaMatch[]): void {
  setState('history', history);
}

export function applyPreset(preset: ArenaPreset): void {
  const competitors: ArenaCompetitor[] = preset.competitors.map((c) => ({
    id: crypto.randomUUID(),
    name: c.name,
    command: c.command,
  }));
  setState('competitors', competitors);
}

export function saveCurrentAsPreset(name: string): void {
  const preset: ArenaPreset = {
    id: crypto.randomUUID(),
    name,
    competitors: state.competitors
      .filter((c) => c.name.trim() && c.command.trim())
      .map((c) => ({ name: c.name, command: c.command })),
  };
  setState('presets', (prev) => [...prev, preset]);
}

export function deletePreset(id: string): void {
  setState('presets', (prev) => prev.filter((p) => p.id !== id));
}

// --- Reset ---

export async function resetForNewMatch(): Promise<void> {
  await cleanupBattleWorktrees();
  setState('phase', 'config');
  setState('battle', []);
  setState('competitors', [makeEmptyCompetitor(), makeEmptyCompetitor()]);
  setState('prompt', '');
  setState('cwd', '');
  setState('selectedHistoryMatch', null);
}

export async function resetForRematch(): Promise<void> {
  await cleanupBattleWorktrees();
  setState('phase', 'config');
  setState('battle', []);
  setState('selectedHistoryMatch', null);
}

// --- Validation ---

export function canFight(): boolean {
  const filled = state.competitors.filter((c) => c.name.trim() !== '' && c.command.trim() !== '');
  return filled.length >= MIN_COMPETITORS && state.prompt.trim() !== '' && state.cwd !== '';
}
