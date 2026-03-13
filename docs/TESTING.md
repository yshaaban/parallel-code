# Testing Strategy

This document describes the current testing strategy for Parallel Code and the principles behind it.

It is intentionally architecture-focused. The goal is not just to grow the number of tests. The goal is to make future changes safer, especially in the parts of the system that are hardest to debug:

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

1. deeper browser-mode scenario coverage for reconnect, restore, and pushed state
2. more keyboard/focus/navigation behavior tests where task and sidebar flows evolve
3. app-level coverage for attention inbox behavior across reconnect and recovery
4. app-level coverage for task preview flows and detected-port suggestion behavior as preview support grows
5. app-level coverage for more advanced review and terminal UX when those features grow
6. additional startup and reconciliation scenarios whenever persistence or restore semantics change

## What To Avoid

Avoid adding tests that only prove:

- a specific helper was called
- a specific implementation detail still exists
- a temporary polling path still fires on schedule

Those tests are sometimes useful locally, but they are not the main quality bar for this codebase.
