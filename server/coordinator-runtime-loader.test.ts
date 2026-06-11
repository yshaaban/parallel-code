import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCoordinatorRun,
  getCoordinatorRuntimeState,
  resetCoordinatorRuntimeForTests,
  type CoordinatorEventListener,
} from '../electron/coordinator/runtime.js';
import { saveCoordinatorRuntimeStateForEnv } from '../electron/coordinator/persistence.js';
import { resetCoordinatorServiceForTests } from '../electron/coordinator/service.js';
import { resetCoordinatorToolGatewayForTests } from '../electron/coordinator/tool-gateway.js';
import type { HandlerContext } from '../electron/ipc/handler-context.js';
import { startCoordinatorRuntimeLoad } from './coordinator-runtime-loader.js';

function createHandlerContext(userDataPath: string): HandlerContext {
  return {
    userDataPath,
    isPackaged: false,
    sendToChannel: () => {},
  };
}

const taskNamesStub = {
  deleteTask: () => {},
  registerCreatedTask: () => {},
};

describe('coordinator runtime loader', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    resetCoordinatorToolGatewayForTests();
    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();
    if (tempDir) {
      fs.rmSync(tempDir, { force: true, recursive: true });
      tempDir = null;
    }
  });

  it('repairs early-bootstrapped clients by re-emitting hydrated runs after load', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-runtime-loader-'));
    const env = { userDataPath: tempDir, isPackaged: false } as const;

    // Seed persisted coordinator state, then drop the in-memory runtime so the
    // loader has to hydrate it from disk (a fresh server process).
    const run = createCoordinatorRun({
      coordinatorTaskId: 'task-coordinator',
      now: 1_000,
      projectId: 'project-1',
      projectMode: 'git',
      projectRoot: '/repo',
    });
    saveCoordinatorRuntimeStateForEnv(env, getCoordinatorRuntimeState());
    resetCoordinatorServiceForTests();
    resetCoordinatorRuntimeForTests();

    const received: Array<{ eventType: string; runId: string }> = [];
    const emitCoordinatorChanged: CoordinatorEventListener = (event) => {
      received.push({ eventType: event.eventType, runId: event.runId });
    };

    const loader = startCoordinatorRuntimeLoad({
      emitCoordinatorChanged,
      handlerContext: createHandlerContext(tempDir),
      taskNames: taskNamesStub,
    });

    try {
      await loader.ready;
      // A client that authenticated before the post-listen load finished got an
      // empty coordinator bootstrap; the repair events delivered through the
      // control-plane subscription are what bring it up to date.
      expect(received).toContainEqual({ eventType: 'run-upserted', runId: run.id });
    } finally {
      await loader.cleanup();
    }
  });

  it('emits no repair events when there is no persisted coordinator state', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-runtime-loader-'));

    const received: unknown[] = [];
    const loader = startCoordinatorRuntimeLoad({
      emitCoordinatorChanged: (event) => received.push(event),
      handlerContext: createHandlerContext(tempDir),
      taskNames: taskNamesStub,
    });

    try {
      await loader.ready;
      expect(received).toEqual([]);
    } finally {
      await loader.cleanup();
    }
  });
});
