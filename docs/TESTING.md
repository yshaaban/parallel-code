# Testing Strategy

This document describes the current testing strategy for Parallel Code and the principles behind it.

It is intentionally architecture-focused. The goal is not just to grow the number of tests. The goal is to make future changes safer, especially in the parts of the system that are hardest to debug:

Read these first when deciding where behavior should live or how an upstream test should be adapted locally:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)

- reconnect and replay behavior
- startup and persistence
- multi-client control
- server-owned pushed state
- backend supervision and attention routing
- task-scoped preview routing and replay
- review readiness, overlap, and convergence queueing
- high-churn product screens

## Testing Principles

The current test strategy should stay aligned with these rules:

1. Test architectural contracts, not temporary implementation details.
2. Prefer server-authoritative contracts for server-owned state.
3. Prefer race, replay, and recovery coverage over shallow collaborator-call tests.
4. Use node-side tests for transport, workflow, and lifecycle behavior.
5. Use Solid/jsdom tests for high-churn product behavior.
6. Add tests that will still be valuable after refactors, not tests that only mirror current helper structure.

Architecture guardrails are also part of the suite now. We intentionally keep a small set of source-level architecture tests around:

- bootstrap registry completeness
- startup listener ownership
- review-surface freshness boundaries
- task-row presentation boundaries

These are meant to protect design constraints that are easy to violate accidentally and expensive to rediscover later.

## Test Suite Split

The test suite is intentionally split into two runtime-specific configs.

### 1. Node Suite

Config:

- `vitest.config.ts`

Command:

- `npm run test:node`

What it covers:

- backend workflows
- IPC handlers
- websocket transport
- browser server behavior
- supervision analysis and replay
- task-port detection, exposure, and browser preview proxying
- PTY and latency behavior
- reconnect, replay, and control-lease contracts
- startup/reconciliation logic that does not require a DOM

This suite is the main protection for correctness and reliability.

### 2. Solid Screen Suite

Config:

- `vitest.solid.config.ts`

Command:

- `npm run test:solid`

What it covers:

- `src/components/TaskPanel.tsx`
- `src/components/TerminalView.tsx`
- `src/components/Sidebar.tsx`
- `src/components/ChangedFilesList.tsx`
- `src/components/ReviewPanel.tsx`
- `src/components/ConnectPhoneModal.tsx`
- `src/components/SidebarTaskRow.tsx`
- `src/components/ExposePortDialog.tsx`
- `src/components/PreviewPanel.tsx`

This suite protects user-facing behavior in the highest-churn UI surfaces.

## What The Current Tests Are Meant To Prove

### Reliability And Recovery

The node suite should continue to prove that:

- reconnect receives the latest replayable state
- stale events do not mutate current live state
- control leases stay exclusive and release correctly
- backpressure and flow control do not corrupt other clients
- startup and cleanup ordering remain safe
- supervision snapshots replay correctly after reconnect
- prompt / question / quiet-state detection produces stable attention states
- task-port snapshots replay correctly after reconnect
- browser preview proxying stays auth-gated and task-scoped
- startup/bootstrap registry behavior and architecture guardrails around runtime state ownership

Representative files:

- `tests/contracts/*.test.ts`
- `server/terminal-latency.test.ts`
- `src/lib/ipc.test.ts`
- `src/lib/websocket-client.test.ts`
- `src/runtime/server-sync.test.ts`
- `src/runtime/browser-session.test.ts`

### Product Behavior

The Solid screen suite should continue to prove that:

- task actions open the right dialogs and recover correctly
- preview expose dialogs reset and validate correctly across reopen
- terminal views start, clean up, and react to state changes correctly
- sidebar actions trigger the right flows
- task rows surface compact attention and review state without overpowering the task list
- changed-files and review views react to pushed git state correctly
- remote access UI reacts to pushed status and host startup behavior correctly
- task attention state stays aligned with backend supervision and lifecycle fallbacks
- review signals reflect convergence state without diverging from the canonical task list
- review summaries reflect canonical merge-readiness and overlap signals

### Startup, Persistence, And Reconciliation

The integration tests around startup and persistence should continue to prove that:

- early pushed events are not lost during boot
- buffered startup events are dropped if the session is disposed before boot completes
- state is saved on the relevant lifecycle boundaries
- legacy persisted state still hydrates correctly
- corrupted persisted data is handled safely

Representative files:

- `src/app/desktop-session.test.ts`
- `src/store/persistence.test.ts`

## Current Philosophy Around Server-Owned State

For state the server is responsible for, the preferred model is:

1. backend detects or computes the canonical state
2. backend pushes or replays that state
3. clients project it into UI state
4. targeted refetch is a fallback, not the primary ownership model

This especially applies to:

- git status
- remote access status
- task attention / agent supervision
- task port observation and exposure
- branch-review and convergence inputs derived from git state
- replayable browser control-plane state

Tests should reinforce that ownership model rather than encoding client polling as the desired behavior.

## What To Add Next

The next valuable testing work should be:

1. deeper browser-mode scenario coverage for reconnect, restore, pushed state, and multi-client churn
2. deploy smoke tests for standalone browser mode and auth/bootstrap behavior
3. stress and diagnostics coverage around long-lived browser sessions, preview probing, and terminal latency/replay flows
4. more keyboard/focus/navigation behavior tests where task and sidebar flows evolve
5. app-level coverage for task preview flows and detected-port suggestion behavior as preview support grows
6. additional startup and reconciliation scenarios whenever persistence or restore semantics change

## Headless Stress Harnesses

Use the stress harnesses when you need to surface multi-user fanout, restore amplification, or hot-session terminal delivery issues without relying on the UI.

Fast seams:

- `npx vitest run --config vitest.config.ts tests/contracts/control-plane-stress.contract.test.ts`
- `npx vitest run --config vitest.config.ts server/session-stress.test.ts`

Manual runner:

- `npm run stress:session -- --users 3 --terminals 12 --lines 40 --reconnects 1`
- `npm run stress:session -- --users 8 --terminals 12 --lines 120 --output-line-bytes 4096 --input-chunks 48 --input-chunk-bytes 4096 --mixed-lines 60 --mixed-line-bytes 4096`
- `npm run stress:session -- --users 8 --terminals 16 --input-chunks 24 --input-chunk-bytes 32768 --mixed-lines 40 --mixed-line-bytes 8192`

Optional network shaping:

- `npm run stress:session -- --users 4 --terminals 16 --lines 80 --reconnects 2 --latency-ms 40 --jitter-ms 20 --packet-loss 0.02`

Harness notes:

- `--lines 0`, `--input-chunks 0`, and `--mixed-lines 0` skip those phases entirely so you can isolate one part of the workload.
- reconnect sweeps reuse a stable browser `clientId` and `lastSeq` cursor so they exercise replay/restore behavior instead of only simulating fresh peers joining.

Use the layers for different questions:

1. `control-plane-stress.contract.test.ts`
   proves broadcast fanout and slow-consumer isolation cheaply in-process
2. `server/session-stress.test.ts`
   proves a real server, real PTYs, multiple users, and channel fanout can survive a hot shared session
3. `scripts/session-stress.mjs`
   gives a repeatable local runner for parameter sweeps and regression comparisons outside the UI

Watch these outputs first:

- burst wall-clock duration
- per-marker inter-client skew
- total websocket messages and bytes per run
- reconnect burst cost compared to the initial burst
- backend `ptyInput` diagnostics:
  - `enqueuedMessages`
  - `coalescedMessages`
  - `flushes`
  - `maxQueuedChars`
- backend `browserControl` diagnostics:
  - `backpressureRejects`
  - `notOpenRejects`

If a shared-session regression appears in the browser, reproduce it with the headless harness before tuning UI code. This keeps the investigation focused on transport, replay, restore, PTY, or fanout ownership instead of frontend noise.

Use the phases for different questions:

1. output phase
   isolates channel fanout and shared-session delivery cost
2. input phase
   isolates browser-control input volume, PTY queueing, and paste-like bursts
3. mixed phase
   isolates TUI-style concurrent input/output pressure on the same hot session

Recent lesson:

- heavy browser input above the old websocket parser ceiling was being silently dropped until the stress harness started sending multi-kilobyte writes
- after that fix, the next real cliff was slow-link channel backpressure under many shared terminals, not PTY input loss

## Porting Upstream Tests

When porting upstream changes, do not copy tests mechanically just because the feature is similar.

Port tests by local seam:

1. if the behavior is backend-owned here, test it in the node suite even if upstream proved it through a UI test
2. if the behavior is renderer-only here, prefer a Solid test even if upstream proved it through a broader integration path
3. if the port crosses backend, workflow, and UI boundaries here, split proof across the relevant seams instead of forcing one giant copied test

Good ported tests prove:

- the same user-visible behavior
- the correct local authority model
- the timing/replay/recovery expectations of this repo

Bad ported tests prove:

- the old upstream file layout still exists
- the old upstream helper graph is still present
- a copied test happens to pass while missing the real local ownership seam

When in doubt, ask:

- where does this behavior live in this repo now?
- what is the thinnest test that proves it at that seam?

## Timer Hygiene

Timer-driven node tests should be defensive about suite order and cleanup.

Use these rules whenever a test relies on `vi.useFakeTimers()`:

1. force `vi.useRealTimers()` in `beforeEach` so the test does not inherit timer state from a previous case
2. clear timers and restore real timers in `afterEach`
3. clean up long-lived intervals or background timers in `finally` blocks when the test can fail before the normal teardown path
4. prefer `await vi.advanceTimersByTimeAsync(...)` when the code under test can queue follow-up microtasks

This matters most for:

- websocket heartbeat loops
- startup/replay flows
- retry/backoff logic
- browser control-plane queue draining

The goal is to keep timer-based tests deterministic in isolation and under the full suite.

## Shared Harness Hygiene

Some runtime and startup tests use shared mock registries for listeners, window events, or replay callbacks.

When those harnesses change, follow these rules:

1. cleanup should remove the exact listener that was registered, not just "whatever is currently stored for this event name"
2. readiness waits should target the real completion signal for the behavior under test, not the earliest incidental call in the startup chain
3. if a failure appears only under the full suite, rerun the file in isolation first, then fix the harness cause instead of broadening timeouts

This matters most for:

- startup and restore sequencing
- browser reconnect and replay
- preview and remote-access listener wiring

## Handler And Persistence Boundary Tests

When transport, handler typing, or saved-state parsing changes, add direct node tests for the boundary itself.

Use these rules:

1. request-bearing IPC handlers should prove that missing required payloads fail as `BadRequestError`
2. explicitly optional request channels should prove that omitted payloads still take the intended default path
3. shared persisted-state parsers should prove legacy, partial, and empty fragments normalize the same way for every consumer
4. if a restore path intentionally ignores fields like display-only names, cover that with a direct regression instead of relying on a broader startup test

These tests are valuable because they keep request-shape drift and saved-state drift from hiding behind larger integration flows.

## What To Avoid

Avoid adding tests that only prove:

- a specific helper was called
- a specific implementation detail still exists
- a temporary polling path still fires on schedule

Those tests are sometimes useful locally, but they are not the main quality bar for this codebase.
