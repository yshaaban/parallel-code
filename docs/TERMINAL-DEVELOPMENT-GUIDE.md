# Terminal Development Guide

This document is the practical contributor guide for terminal, browser-control, browser-lab,
restore, and terminal-performance work in Parallel Code.

Read this after:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TESTING.md](./TESTING.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)

Use this guide when you are:

- changing PTY lifecycle or output batching
- changing browser terminal input/output/recovery behavior
- changing takeover, task-command control, or resize authority
- adding or debugging browser-lab coverage
- debugging large-history TUI switching, reload, or reconnect issues

This document intentionally focuses on what is hard to infer quickly from the code alone.

## Quick Start

If you touch browser terminal runtime, browser harness, or terminal restore behavior:

1. run the scripted browser terminal matrix:
   - `npm run test:browser:terminal`
2. run the backend/runtime seams:
   - `npx vitest run --config vitest.config.ts server/terminal-latency.test.ts server/session-stress.test.ts electron/ipc/pty.test.ts electron/ipc/handlers.restore.test.ts src/lib/scrollbackRestore.test.ts src/app/task-command-lease.test.ts`
3. if the issue is about latency or noisy background contention, run the scripted local profiler:
   - `npm run profile:terminal:latency`
4. finish with the remaining broad checks:
   - `npm run check -- --pretty false`
   - `npm test`

If Playwright Chromium is missing:

- `npx playwright install chromium`

## Automated Local Repro

Prefer repo entrypoints that launch a fresh standalone server for you:

- `npm run test:browser:terminal`
- `npm run profile:terminal:latency`

Do not make a hand-managed `npm run server` process your primary validation path. The scripted
paths avoid the stale-server problem that is easy to miss during browser terminal debugging.

`npm test` is not the browser-terminal full gate by itself. It covers node + Solid suites only, so
the scripted browser terminal matrix above is part of the gate.

## Owner Map

Treat terminal work as `reimplement on our architecture`.

Primary local owners:

- backend
  - `electron/ipc/pty.ts`
  - `electron/ipc/agent-handlers.ts`
  - `electron/ipc/task-command-leases.ts`
  - `electron/ipc/runtime-diagnostics.ts`
- handler / transport
  - `server/browser-channels.ts`
  - `server/browser-websocket.ts`
  - `src/lib/ipc.ts`
  - `src/lib/browser-http-ipc.ts`
- workflow / app
  - `src/app/task-command-lease.ts`
  - `src/app/task-workflows.ts`
  - `src/app/terminal-output-scheduler.ts`
  - `src/app/terminal-attach-scheduler.ts`
- presentation
  - `src/components/terminal-view/terminal-session.ts`
  - `src/components/TerminalView.tsx`
- browser-lab harness
  - `tests/browser/harness/fixtures.ts`
  - `tests/browser/harness/scenarios.ts`
  - `tests/browser/harness/standalone-server.ts`

Do not move backend recovery or control truth into renderer heuristics.

## Non-Trivial Truths

### 1. The browser lab runs against built artifacts, not live source

Playwright browser-lab coverage runs against `dist`, `dist-remote`, and `dist-server`.

Practical consequence:

- after changing browser terminal/runtime code, browser-lab results are only meaningful if you rebuilt
- `tests/browser/harness/standalone-server.ts` now enforces freshness, but you should still think this way while debugging

### 2. `ready` is stricter than “textarea exists”

For browser terminals, `ready` should mean:

- xterm fit is ready
- restore is complete
- restore pause has resumed
- queued resize work can drain
- queued input can drain

That is why browser-lab tests should prefer the harness readiness helpers instead of ad hoc DOM checks.

### 2a. Terminal status attributes have specific meanings

`data-terminal-status` is part of the terminal lifecycle contract.

Treat the values this way:

- `binding`
  - session exists, but backend channel bind or session wiring is not complete
- `attaching`
  - initial xterm attach / fit / first-mount readiness is still in progress
- `restoring`
  - a blocking recovery path is running; this should be rare and should normally mean snapshot
    fallback, not ordinary delta catch-up
- `ready`
  - fit, restore gating, and post-restore input/resize draining are complete enough for real
    interaction
- `error`
  - the terminal session failed and is not interactable

Important rule:

- `delta` and `noop` recovery should not surface `restoring`
- if a churn or reload scenario shows `restoring` unexpectedly, treat that as a recovery-policy
  bug, not just a UI detail

### 3. The hidden xterm helper textarea is not a reliable click target

The textarea can be attached while partially offscreen or not practically clickable.

Use:

- `browserLab.waitForTerminalReady(...)`
- `browserLab.focusTerminal(...)`
- direct `.focus()` when a test specifically needs “type during restore”

Avoid brittle raw click steps unless the click itself is what you are testing.

### 4. Large-history TUI switching bugs are usually recovery-policy bugs

If a large-history TUI:

- blanks
- flashes
- refills the same history again
- becomes slow when switching away and back

the problem is usually not a simple panel remount. The common causes are:

- channel continuity loss
- recovery fallback taking the snapshot/reset lane too often
- browser terminal reporting `ready` too early
- background terminal work consuming too much scheduler/render budget

### 5. Plain rebind and structured recovery are different paths

Plain channel rebind should resume live output and backlog delivery.
Historical recovery should go through the structured terminal recovery contract.

Do not reintroduce “history replay through live `Data`” on rebind.

### 6. Shell layout persistence matters for browser reload coverage

Browser shell panels are part of workspace/session persistence behavior.

Practical consequence:

- creating or closing a shell terminal in browser mode must persist layout state promptly
- otherwise reload/restore tests can fail because the shell surface itself disappears, which looks like a terminal bug but is actually a persistence bug

### 7. The stress harness must stay aligned with the real lease contract

The task-command lease path now requires `ownerId`, not only `clientId`.

Practical consequence:

- stress and churn helpers must use the current lease contract or they silently stop exercising the real control model
- full `npm test` is important here because targeted terminal tests may miss harness drift

### 8. Reset diagnostics before profiling or churn debugging

The profiler and recovery diagnostics are only useful if they describe the scenario you just ran.

Reset first, then compare:

- backend recovery counters
- browser trace timings
- terminal status history

## Recovery Model To Preserve

Browser terminal recovery is backend-owned and explicit.

Current model:

1. live output arrives over the channel stream
2. continuity loss is signaled as `RecoveryRequired`
3. the renderer requests `GetTerminalRecoveryBatch`
4. the backend returns one of:
   - `noop`
   - `delta`
   - `snapshot`

Important request state:

- `outputCursor`
- retained rendered tail

Recovery preference:

1. cursor-based delta when the requested cursor is still in the retained backend window
2. rendered-tail overlap delta when cursor continuity is unavailable
3. snapshot fallback only when delta cannot be proven

Important UI rule:

- only `snapshot` recovery may surface blocking `restoring` UI or call `term.reset()`
- `delta` and `noop` recovery should stay non-blocking

Important anti-patterns:

- do not use `GetAgentScrollback` or `GetScrollbackBatch` for terminal attach/restore
- do not treat `RecoveryRequired` as permission to replay historical output through the live channel
- do not “fix” flicker by hiding the terminal while still taking the destructive recovery path unnecessarily

## Browser-Lab Workflow

### Core harness files

- `tests/browser/harness/fixtures.ts`
- `tests/browser/harness/scenarios.ts`
- `tests/browser/harness/standalone-server.ts`

### Most useful helpers

- `openSession(...)`
- `waitForTerminalReady(...)`
- `focusTerminal(...)`
- `typeInTerminal(...)`
- `runInTerminal(...)`
- `createShellTerminal(...)`
- `waitForAgentScrollback(...)`
- `beginTerminalStatusHistory(...)`
- `readTerminalStatusHistory(...)`

### When to use status history

Use terminal status history when testing recovery semantics, not just end state.

Examples:

- prove delta/noop recovery never entered blocking `restoring`
- prove reload/restore only blocks on real snapshot fallback
- prove a terminal can accept input while recovery is completing

### Scenario choice

Use:

- `createInteractiveNodeScenario()`
  - direct typing and echo-path debugging
- `createPromptReadyScenario()`
  - browser mount, readiness, reload/restore, shell switching
- custom shell commands inside browser-lab tests
  - large-history and noisy background cases

### When a browser test fails unexpectedly

Check these first:

1. did you rebuild standalone artifacts?
2. is the failure really terminal lifecycle, or did the shell/task layout fail to persist?
3. are you waiting on `ready`, or only on the absence of one loading string?
4. did the test use a brittle click on the helper textarea when a focus-based step was enough?

## Diagnostics And Profiling Workflow

### Browser-side trace

Enable in devtools:

- `window.__TERMINAL_PERF__ = true`

Use:

- `src/lib/terminalLatency.ts`

This is the right seam when the question is:

- “is latency before send?”
- “is latency after send but before visible echo?”
- “does noisy background output increase render delay?”

### Real browser profiler

Default entrypoint:

- `npm run profile:terminal:latency`

Raw script:

- `scripts/profile-terminal-input-latency.mjs`

Important behavior:

- it warms tracing before measuring
- it supports quiet and noisy-background scenarios
- it is useful for localhost diagnosis when the product “feels choppy” but backend queue metrics are small

### Backend runtime diagnostics

Use:

- `IPC.ResetBackendRuntimeDiagnostics`
- `IPC.GetBackendRuntimeDiagnostics`
- `electron/ipc/runtime-diagnostics.ts`

This is the right seam when the question is:

- “did recovery use noop, delta, or snapshot?”
- “was delta cursor-based or tail-based?”
- “did backpressure or recovery counters increase during switching?”

For recovery debugging, reset diagnostics before the scenario you actually want to measure.

## Debugging Order

When a terminal/browser bug is still ambiguous, use this order:

1. run the scripted browser matrix or profiler first
2. decide whether the symptom is:
   - input latency
   - output/render contention
   - recovery/restore churn
   - control/takeover drift
3. reset backend diagnostics
4. enable browser tracing if latency or render timing is part of the question
5. capture terminal status history if restore/recovery is part of the question
6. run the smallest targeted browser and backend seams before touching broader suites

This order is deliberately boring. It is much faster than chasing symptoms from a stale server or
from already-contaminated diagnostics.

## Validation Recipes By Change Type

### 1. Interactive typing / latency changes

Run:

- `server/terminal-latency.test.ts`
- `tests/browser/terminal-input.spec.ts`
- `tests/browser/terminal-noisy-background.spec.ts`

Also use:

- `npm run profile:terminal:latency`

### 2. Recovery / rebind / large-history TUI changes

Run:

- `electron/ipc/pty.test.ts`
- `electron/ipc/handlers.restore.test.ts`
- `src/lib/scrollbackRestore.test.ts`
- `tests/browser/terminal-restore.spec.ts`

Specifically assert:

- no historical live replay on rebind
- snapshot fallback count stays at zero for expected delta/noop cases
- terminal status history does not include `restoring` for non-blocking recovery scenarios

### 3. Control / takeover / resize-authority changes

Run:

- `src/app/task-command-lease.test.ts`
- `server/browser-control-plane.test.ts`
- `server/session-stress.test.ts`
- `tests/browser/multiclient-control.spec.ts`

Do not stop at a targeted unit file here. The stress suite catches lifecycle drift that targeted tests can miss.

Known proof gap:

- different-width resize-authority flows still need stronger browser-lab coverage
- attach-priority changes still need explicit scheduler-budget proof

If you change either area, add coverage or equivalent new validation before calling the slice done.

### 4. Shared browser harness changes

Run:

- the targeted browser specs you changed
- `npm test`

Reason:

- shared harness drift often appears only when different browser/runtime suites run together or when a helper no longer matches the real backend contract

## Common Review And Debugging Mistakes

- trusting browser-lab results from stale build artifacts
- treating terminal readiness as “the textarea exists”
- adding renderer heuristics instead of fixing backend-owned recovery truth
- using `GetAgentScrollback` as an attach/restore shortcut
- forgetting that shell layout persistence can masquerade as a terminal restore bug
- fixing only the happy-path browser spec and skipping churn/stress coverage
- updating the backend control contract without updating the stress harness helpers

## Definition Of Done For Terminal/Browser Changes

A terminal/browser slice is not done when one narrow repro stops reproducing.

It is done when:

- ownership is correct at the right layer
- non-destructive recovery paths stay non-destructive
- the terminal/browser full gate is green:
  - `npm run test:browser:terminal`
  - targeted backend/runtime seams
  - `npm run check -- --pretty false`
  - `npm test`
- targeted node/runtime/browser seams are green
- the relevant stress or churn suites are green
- the docs in this directory describe the new behavior clearly enough for the next contributor

## What To Update With The Code

When terminal/browser behavior changes materially, update the right docs in the same branch:

- [ARCHITECTURE.md](./ARCHITECTURE.md)
  - current system behavior
- [TESTING.md](./TESTING.md)
  - validation layers and reusable test strategy
- [REVIEW-RULES.md](./REVIEW-RULES.md)
  - reusable review/debugging lessons
- [TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md)
  - deferred architecture ideas and next steps
- this file
  - practical workflow, harness usage, and non-obvious contributor knowledge
