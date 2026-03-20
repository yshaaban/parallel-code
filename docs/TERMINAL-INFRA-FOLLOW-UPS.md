# Terminal And Browser-Control Follow-Ups

This document captures follow-up ideas after the recent browser-control, latency, takeover,
terminal attach, restore, and lifecycle hardening work.

It is not the canonical architecture document. Read these first for current truth and architectural
rules:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TESTING.md](./TESTING.md)
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)

Use this note when deciding what to simplify next, what to measure next, and what should stay
deferred unless the data justifies it.

## Purpose

The recent work fixed several real failure classes:

- stale retained control after takeover or transport loss
- ghost-send behavior across reconnect
- stale pending takeover requests
- task ownership and per-agent controller drift
- destructive terminal restore behavior and visible TUI instability
- timer and cleanup inconsistencies that only appeared under full-suite load

Those fixes improved correctness and exposed a clearer long-term direction:

1. the browser control plane should become more explicit, not more clever
2. terminal transport should distinguish interactive work from bulk work
3. lifecycle-sensitive code should prefer explicit state machines and generations over ad hoc flags
4. correctness needs stronger invariant and stress coverage, not only more happy-path tests

## Non-Negotiable Architectural Constraints

Any future work in this area should continue to respect these rules:

1. backend or browser control plane owns canonical multi-client state
2. transport classes route and validate, but do not own task policy
3. renderer can optimize scheduling, but must not speculate on terminal truth
4. dialogs, banners, and leaf components present control state; they do not define it
5. local terminal fit stays local and must not imply PTY resize authority

## Near-Term Recommendation

If we only take a few follow-up slices soon, take them in this order:

1. explicit browser command classes so ephemeral work never rides reconnect queues by accident
2. a single clearer ownership model for task control, terminal control, and resize authority
3. a first-class takeover state machine with explicit disconnect and timeout transitions
4. model-based multi-client invariants plus invariant-aware stress checks
5. differential restore only after ownership and transport semantics are simpler

## What To Improve Next

### 1. Make Browser Commands Explicitly Classed

Several recent bugs came from treating all browser commands as if they had the same lifecycle.

Future direction:

- define explicit command classes:
  - `immediate`
  - `queueable`
  - `replayable`
  - `ephemeral`
- keep `input`, `resize`, and takeover request/response on the `immediate` / non-reconnecting path
- keep presence, bootstrap, and replayable state refresh on reconnect-safe paths
- keep command-class policy in one transport seam instead of spreading it across callers

Why this helps:

- prevents ghost work after reconnect
- makes lifecycle expectations visible in code review
- reduces the chance that a new ephemeral command accidentally inherits queue-on-reconnect behavior

Likely owner:

- handler / transport

Validation seam:

- node / backend
- runtime / integration

Recommendation:

- treat this as the default transport model for future browser control-plane commands, not a one-off
  fix for terminal input

### 2. Collapse Control Ownership Into A Clearer Model

Task ownership and per-agent terminal ownership are currently related but still require
reconciliation.

Future direction:

- make task control the primary ownership model
- make per-agent terminal control either:
  - explicitly derived from task ownership, or
  - owned by one canonical server-side controller graph instead of opportunistic reconciliation
- ensure resize authority is part of the same ownership family instead of a parallel concept

Why this helps:

- fewer ways for control state to drift
- fewer cleanup paths that need bespoke repair logic
- simpler takeover and disconnect semantics

Likely owner:

- backend
- workflow / app

Validation seam:

- node / backend
- browser lab

Recommendation:

- do not move this logic into terminal components
- prefer a server-owned state machine plus thin client projections

### 3. Promote Takeover Into A First-Class State Machine

The takeover path is still more implicit than ideal.

Future direction:

- model task takeover requests as explicit states:
  - `idle`
  - `requested`
  - `awaiting-owner`
  - `approved`
  - `denied`
  - `timed-out`
  - `force-eligible`
  - `canceled`
- define canonical transitions for:
  - owner disconnect
  - requester disconnect
  - controller change
  - timeout
  - transport loss
- emit those transitions as explicit control-plane events

Why this helps:

- easier reasoning about races
- easier stress/fuzz testing
- less UI ambiguity around what the user should see

Likely owner:

- backend
- handler / transport

Validation seam:

- node / backend
- browser lab

Recommendation:

- keep timeout policy and resolution rules out of dialogs
- dialog and banner surfaces should consume state-machine output, not define it

### 4. Add Periodic Server-Side Reconciliation For Live Control State

Recent fixes added targeted reconciliation. A periodic audit pass would make the system more
robust under rare or future failure modes.

Future direction:

- add a light server-side audit loop that periodically checks:
  - task owners
  - agent controllers
  - resize authority
  - pending takeover requests
  - peer presence
- repair or prune impossible combinations
- emit diagnostics when repair happens

Why this helps:

- catches missed cleanup paths
- makes latent drift observable
- gives production diagnostics a place to attach invariant failures

Likely owner:

- backend

Validation seam:

- node / backend
- stress harness

Recommendation:

- keep the audit loop conservative and idempotent
- prefer logging and repair over silently mutating state without diagnostics

### 5. Use Generation Tokens And Abortable Operations More Consistently

Some recent bugs were stale-work bugs, not raw logic bugs.

Future direction:

- use generation tokens or explicit operation IDs for:
  - terminal session lifetime
  - control handoff requests
  - restore requests
  - active preview scans
  - future multi-step browser workflows
- add abortable send/operation wrappers for cancellable client work

Why this helps:

- stale results cannot mutate newer sessions
- reconnect and teardown bugs become easier to reason about
- lifecycle cleanup becomes less dependent on timing luck

Likely owner:

- workflow / app
- handler / transport

Validation seam:

- runtime / integration
- browser lab

Recommendation:

- use the same pattern repeatedly instead of inventing new ad hoc invalidation flags

### 6. Keep Interactive And Bulk Terminal Traffic On Different Policies

Interactive typing and bulk replay are not the same workload and should continue to diverge.

Future direction:

- keep a dedicated interactive fast path for:
  - small terminal input
  - control keys
  - small echo-sized output
- keep bounded batching and restore-specific scheduling for:
  - paste
  - replay
  - large output bursts
  - background terminal attach
- consider per-lane diagnostics and budgets instead of one monolithic terminal latency number

Why this helps:

- the common path stays fast
- heavy workloads stay safe
- performance tuning remains measurable instead of anecdotal

Likely owner:

- backend
- handler / transport
- workflow / app

Validation seam:

- node / backend
- stress harness
- browser lab

Recommendation:

- keep this model even if a future binary input fast path is added

### 7. Prefer Differential Restore Over Destructive Reset

Terminal restore and reconnect issues have repeatedly shown that full reset and replay is too blunt
for many TUIs.

Future direction:

- track recent output by sequence and restore incrementally when possible
- keep hard reset as a fallback, not the default
- distinguish:
  - reconnect catch-up
  - renderer-loss repaint
  - hard reset recovery
- keep the visible viewport stable until replacement content is ready

Why this helps:

- less flicker
- better TUI stability
- less redundant work during reconnect and late join

Likely owner:

- backend
- workflow / app

Validation seam:

- node / backend
- browser lab

Recommendation:

- only consider deeper client-side archival or paging if measured replay size and restore time force
  it

### 8. Treat Resize Authority As Part Of Control, Not Just Terminal Geometry

Terminal resize bugs are multi-client control bugs in disguise.

Future direction:

- keep canonical PTY resize authority server-owned
- prevent observer mounts, visibility changes, and local fit from mutating PTY size
- make resize authority transfer explicit with control handoff
- surface mismatch state clearly to observers without letting them clobber the controller

Why this helps:

- fewer surprising PTY reflows
- simpler mental model for multi-client terminal behavior
- easier invariant testing

Likely owner:

- backend
- workflow / app

Validation seam:

- node / backend
- browser lab
- stress harness

Recommendation:

- keep local xterm fit as presentation only

### 9. Make Background Attach And Replay Explicitly Lower Priority

Mount-driven terminal attach has improved, but the longer-term design should make scheduler policy
the only authority for expensive attach work.

Future direction:

- keep active task and active terminal attach first
- delay background restore and replay until the visible task is usable
- cap concurrent background attaches
- measure first-interactive time separately from total background restore completion

Why this helps:

- better perceived speed
- fewer replay bursts competing with the visible terminal
- less accidental jank on page load

Likely owner:

- workflow / app

Validation seam:

- browser lab
- stress harness

Recommendation:

- do not let low-level terminal views decide attach priority on their own
- keep using the phase-traced startup benchmark before changing concurrency policy again:
  recent results showed queue wait was small while snapshot replay/apply dominated total startup
  time, so any future concurrency work should only proceed after a benchmark proves it beats replay
  throughput tuning on full-terminal completion time
- avoid larger hidden-only or background-only replay chunk jumps without a fresh benchmark: the
  measured startup sweeps showed those profiles regressed `5`-shell completion and could even stall
  `15`-shell manual runs, while the safer mixed profile was the only one that improved full
  completion time

## Reliability And Test Strategy Follow-Ups

### 10. Add Model-Based Multi-Client State-Machine Tests

The current suite is good, but many of the hardest bugs are still “unexpected sequence” bugs.

Future direction:

- build a state-machine or command-sequence harness for multi-client actions:
  - connect
  - disconnect
  - reconnect
  - acquire control
  - request takeover
  - deny / approve
  - resize
  - type
  - restore
  - hide / show tab
- run randomized or matrix-driven sequences against invariant checks

Core invariants:

- at most one controller per task
- at most one resize authority per agent
- stale client work never mutates live ownership
- requester disconnect clears pending owner prompt
- ownership move reconciles dependent control state
- observer resize never changes PTY size

Why this helps:

- catches race conditions humans do not enumerate manually
- protects against future regressions in transport and lifecycle code

Likely owner:

- node / backend
- stress harness

Validation seam:

- node / backend

Recommendation:

- keep this harness deterministic enough to reproduce failures with logged seeds

### 11. Expand Stress Harnesses From Perf-Only To Invariant-Aware

The stress suites should not only measure latency. They should also fail on invalid live states.

Future direction:

- extend stress scenarios to assert:
  - no dual controller states
  - no impossible pending takeovers
  - no stale presence after disconnect
  - no resize-authority drift
  - no replay cursor regressions
- emit invariant counters in diagnostics artifacts

Why this helps:

- performance and correctness failures often share the same underlying race
- makes the heavy harnesses more useful as release gates

Likely owner:

- backend
- diagnostics / testing

Validation seam:

- stress harness

### 12. Standardize Cleanup Discipline In Tests

Several flaky failures this session were test-lifecycle bugs, not product bugs.

Future direction:

- provide shared helpers for:
  - fake timer setup and teardown
  - singleton reset
  - websocket/server cleanup
  - event-listener cleanup
- require those helpers in high-risk suites
- prefer wrappers that make incomplete cleanup harder to write

Compile-time and review-time guard ideas:

- keep `no-floating-promises` strict for test helpers
- use typed cleanup handles or `Disposable`-style wrappers where practical
- prefer APIs that return one structured cleanup object over multiple ad hoc disposers
- keep explicit `resetForTests()` exports for modules with singleton state

Why this helps:

- fewer suite-order failures
- clearer ownership of global test state
- easier review of lifecycle correctness

Likely owner:

- testing utilities

Validation seam:

- docs / sanity
- full-suite stability

Recommendation:

- bias toward patterns that fail loudly when cleanup is forgotten

## Performance Follow-Ups Worth Revisiting Later

These are intentionally deferred until the current latency and restore work has stronger measured
budgets behind it.

### A. Binary Input Fast Path

Possible value:

- remove some serialization cost on the browser hot path

Recommendation:

- revisit only if the current interactive RTT budgets are still not being met after timer,
  batching, and lease hot-path tuning

### B. Richer Differential Screen Snapshots For TUIs

Possible value:

- further reduce flicker for full-screen terminal apps

Recommendation:

- revisit only if sequence-based incremental replay is still insufficient for real TUI workloads

### C. Deeper Scrollback Archival

Possible value:

- reduce restore cost for very large histories

Recommendation:

- revisit only if measured replay bytes and restore time justify the additional complexity
- do not jump to IndexedDB paging by default

## Ideas That Should Stay Deferred Or Avoided

These ideas may look attractive, but they do not currently fit the repo direction well:

- speculative local echo as the default terminal typing path
- moving control ownership into renderer heuristics
- letting dialogs own takeover policy or timeout behavior
- making transport adapters silently rewrite domain meaning
- using destructive full terminal reset as the default reconnect strategy
- optimizing for one benchmark by weakening lifecycle correctness

## Recommended Priority Order

1. command-class transport model
2. control ownership and resize-authority simplification
3. takeover state-machine formalization
4. differential restore and non-destructive reconnect
5. model-based multi-client invariant testing
6. invariant-aware stress harnesses
7. stricter cleanup utilities and singleton reset discipline
8. conditional binary-input or deeper replay work only if metrics still demand it

## Success Criteria For Future Work

Future slices in this area should leave the system with:

- fewer overlapping ownership models
- fewer cleanup paths that rely on timing luck
- explicit transport semantics per command type
- explicit state-machine transitions for takeover and recovery
- measurable interactive vs bulk latency budgets
- invariant-aware stress coverage for multi-client churn
- enough diagnostics to explain field failures without guesswork

The next iteration should make the system simpler and more explicit, not merely faster in one
narrow benchmark.
