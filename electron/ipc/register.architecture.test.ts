import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const registerPath = path.resolve(process.cwd(), 'electron/ipc/register.ts');
const registerSource = readFileSync(registerPath, 'utf8');

describe('electron handler registration architecture guardrails', () => {
  // The coordinator IPC handlers bind lazily, so nothing on the Electron IPC
  // path hydrates coordinator-state.json by itself. The Electron shell must
  // keep the eager hydration call so the renderer's first
  // GetServerStateBootstrap sees restored coordinator runs after an app
  // restart (the browser shell owns the equivalent post-listen load through
  // server/coordinator-runtime-loader.ts).
  it('hydrates persisted coordinator state before binding IPC handlers', () => {
    const ensureIndex = registerSource.indexOf('ensureCoordinatorServiceLoaded({');
    const handlersIndex = registerSource.indexOf('const handlers = createIpcHandlers(');

    expect(ensureIndex).toBeGreaterThan(-1);
    expect(handlersIndex).toBeGreaterThan(-1);
    expect(ensureIndex).toBeLessThan(handlersIndex);
  });
});
