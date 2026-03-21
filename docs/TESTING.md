# Testing Strategy

This document describes what Parallel Code tests are meant to prove.

It is intentionally high level:

- it explains failure patterns, edge cases, and validation seams
- it does not try to be the source of truth for exact commands, profiler invocations, or browser-lab
  runbooks
- terminal/browser workflow details live in
  [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)
- architecture ownership constraints live in [ARCHITECTURE.md](./ARCHITECTURE.md)
- cross-cutting review standards live in [REVIEW-RULES.md](./REVIEW-RULES.md)

Read these first when deciding where behavior should live or how an upstream test should be adapted
locally:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)

## Focus

This strategy is mainly about:

- reconnect and replay behavior
- startup, persistence, and reconciliation
- multi-client presence, takeover, and control
- server-owned pushed state
- terminal rendering, restore, recovery, and focus
- preview detection, exposure, and auth routing
- handler and persistence boundary validation
- high-churn product screens
- shared test harness hygiene

This document answers:

- what kinds of failures need proof
- which validation seam should catch them
- which edge cases are easy to miss
- what counts as sufficient coverage for risky changes

It also records which seams should catch the current architecture splits:

- store boundary drift should be caught by architecture tests before component tests
- TaskPanel permission-flow regressions should be caught by `TaskPanel.architecture.test.ts` and
  `TaskPanel.test.tsx`
- ReviewPanel loading/selection drift should be caught by
  `review-surfaces.architecture.test.ts` and `ReviewPanel.test.tsx`
- terminal startup and replay regressions should be caught by a mix of `Solid / UI` and
  `runtime / integration` proofs

## Validation Layers

Parallel Code uses four main validation layers:

1. `node / backend`
   - contract, handler, workflow, replay, ordering, and recovery semantics
2. `Solid / UI`
   - high-churn screen and component behavior
3. `runtime / integration`
   - real browser, multi-client, restore, focus, and stress/diagnostics behavior
4. `docs / sanity only`
   - documentation-only changes with no runtime behavior impact

There is also a small set of architecture/source-level tests that protect design constraints such
as bootstrap ownership, store-boundary imports, focused-panel reads, and review-surface
composition. Those tests are not a substitute for behavior proof; they exist to fail early when
ownership drifts.

## Core Principles

The current testing strategy should stay aligned with these rules:

1. Test architectural contracts and user-visible behavior, not temporary helper structure.
2. Prefer server-authoritative contracts for server-owned state.
3. Prefer race, replay, ordering, and recovery coverage over shallow collaborator-call assertions.
4. Use the thinnest seam that can still prove the real risk.
5. Use more than one seam when the failure can cross ownership boundaries.
6. Add tests that remain valuable after refactors instead of tests that mirror current plumbing.

## Choosing The Right Seam

Use `node / backend` when the risk is:

- handler validation
- transport semantics
- ordering/version truth
- workflow lifecycle
- replay or recovery policy
- persistence parsing and normalization

Use `Solid / UI` when the risk is:

- a high-churn screen flow
- component-level state transitions
- focus, dialog, banner, or inline status behavior inside one renderer surface
- renderer-side runtime owners that depend on repeated Solid signal updates but do not require a
  real browser/server session
- projection-to-UI mapping that does not require a real browser runtime

Use `runtime / integration` when the risk is:

- browser focus or visibility behavior
- terminal readiness, restore, or rendering timing
- real multi-tab or multi-client behavior
- websocket/auth/bootstrap interaction
- stress, fanout, latency, or replay cost

If the behavior depends on repeated Solid reactive updates, do not validate it only in the plain
node suite. Use `Solid / UI` so the runtime is exercised with client-side reactivity instead of the
server-only one-pass behavior.

## Scoped Vitest Runs

For targeted Vitest runs, prefer the repo wrapper scripts over raw `npm exec vitest ...`:

- `npm run test:node:file -- <file> [more files...]`
- `npm run test:solid:file -- <file> [more files...]`

Those wrappers:

- call the direct Vitest entrypoint instead of relying on `npm exec`
- enforce a default `60s` timeout for ad hoc runs
- terminate the spawned Vitest process tree on timeout or shell shutdown

You can override the timeout with `VITEST_SCOPED_TIMEOUT_MS=<ms>` or
`--timeout-ms <ms>`.

When a Solid/jsdom test waits through transient loading states, avoid patterns like
`waitFor(() => screen.getByText(...))`. Prefer a non-throwing query inside `waitFor`, or a small
helper built on `screen.queryBy...`, so a stale failure path does not repeatedly serialize the DOM
for thrown query errors.

One seam is usually not enough when the change touches:

- browser terminal restore or recovery
- multi-client control and takeover
- startup and persistence ordering
- preview routing across backend plus UI
- shared runtime harnesses

## What Good Coverage Looks Like

Coverage is sufficient when it proves the failure mode that would matter in production.

Examples:

- a handler typing change is sufficiently covered when direct node tests prove exact required and
  optional payload behavior
- a terminal recovery change is sufficiently covered when node tests prove the recovery contract and
  browser/runtime tests prove the user does not see destructive restore behavior unexpectedly
- a terminal startup performance change is sufficiently covered when browser/runtime tests prove the
  end-to-end completion time and measured hot-path phases changed as intended, not only that a
  lower-level scheduler or recovery helper was called; the strongest completion metric is the
  traced `firstQueuedToLastReadyMs`, not a viewport-dependent shell-visible timestamp alone
- a review diff performance change is sufficiently covered when backend tests prove the changed-file
  and per-file diff semantics stayed correct, and the manual review profiler proves cold/warm
  latency moved in the intended direction on a real worktree
- a screen-only layout or banner change is sufficiently covered when Solid tests prove the real
  user-facing transitions
- a sidebar chrome change is sufficiently covered when Solid tests prove the collapse and reopen
  transitions and session-state tests prove the section preference stays local instead of leaking
  into shared workspace persistence
- a store-boundary cleanup is sufficiently covered when architecture tests prove workflow entry
  points moved out of `src/store/*` and the remaining store exceptions are explicitly documented
- a TaskPanel permission-flow split is sufficiently covered when architecture tests prove the
  component uses the named permission controller and Solid tests prove approve/deny behavior still
  resolves through the app-layer workflow
- a ReviewPanel controller split is sufficiently covered when architecture tests prove the component
  no longer owns transport/loading orchestration and Solid tests prove selected-file continuity and
  mode switching still work
- a startup refactor is sufficiently covered when tests prove ordering, cleanup, reconciliation, and
  stale-state repair, not just that bootstrap functions were called
- a required-browser-dialog startup change is sufficiently covered when the shared startup summary
  is visible in the dialog and stays consistent with the standalone startup chip

Coverage is usually not sufficient when it only proves:

- a helper was called
- a mock received the right arguments
- a polling loop still fires
- a component rendered one static string without proving the state transition behind it

## Failure Patterns That Must Be Validated

### Startup, Persistence, And Reconciliation

Validate these failure patterns:

- startup ordering drops or reorders early pushed events
- full-state and workspace-state paths drift apart
- stale persisted state is amplified instead of repaired
- no-op sync paths skip required reconciliation side effects
- task removal clears store records but leaves module-local runtime state behind
- local-only session or layout state is accidentally overwritten by shared workspace state

Edge cases that are easy to miss:

- legacy persisted fragments
- corrupt or partial persisted fragments
- cleanup before startup fully completes
- controller/version state surviving a full-state restore incorrectly
- cleanup authority clearing some task-scoped owners but not others

Preferred proof:

- `node / backend` for parser, reconciliation, and lifecycle contracts
- `runtime / integration` when reconnect/bootstrap ordering is part of the risk

### Review Diff Semantics And Performance

Validate these failure patterns:

- review and non-review surfaces load different diff sources for the same file
- committed review files accidentally fall back to worktree diff semantics
- tracked modified files return `oldContent` and `newContent` but an empty unified `diff`
- cold review file-list loads regress because backend changed-file enumeration adds whole-repo
  scans back into the hot path
- per-file review clicks regress because the backend fans one selection out into unnecessary git
  subprocesses

Preferred proof:

- `node / backend` for:
  - changed-file status semantics
  - modified/add/delete/untracked diff correctness
  - merge-conflict status preservation
- `Solid / UI` for:
  - review surface routing
  - directory-path filtering
  - selected-file continuity
- manual profiler for hot-path latency:
  - `npm run profile:review:diffs -- --worktree-path <path>`
  - pass `--project-root` and `--branch-name` when you need committed branch-file timings too

When measuring review diff performance, record at least:

- cold `get_project_diff(all)` latency on a fresh server
- warm `get_project_diff(all)` latency
- cold per-file `get_file_diff` latency for a representative modified file
- warm per-file `get_file_diff` latency for the same file

### Replay, Reconnect, And Ordering

Validate these failure patterns:

- restore starts from transport-open instead of authenticated control truth
- stale snapshots overwrite newer live state
- reconnect restores the wrong category set or misses replayable state
- clear snapshots drop ordering truth and let older state reapply later
- cross-plane updates race because the backend did not carry sequence/version truth

Edge cases that are easy to miss:

- reconnect during active control
- stale-after-clear controller snapshots
- replay arriving while local optimistic state is still visible
- browser-session disposal before boot completes

Preferred proof:

- `node / backend` for snapshot/version/replay contracts
- `runtime / integration` when the browser reconnect path itself is under review

### Multi-Client Collaboration And Control

Validate these failure patterns:

- ownership is not exclusive
- controller snapshots apply too late or without version gating
- passive observers are prompted repeatedly instead of staying read-only
- takeover queues collapse to one request even though the owner keeps a queue
- task-command control and terminal input control are conflated
- disconnect or auth loss leaves retained lease state behind

Edge cases that are easy to miss:

- owner timeout auto-approval versus force takeover
- multiple simultaneous takeover requests
- reconnect during an outstanding takeover
- remote/mobile visibility hide-show cycles
- first-run remote session naming and submit-flow focus release

Preferred proof:

- `node / backend` for lease and controller semantics
- `runtime / integration` for real multi-client and remote/mobile browser behavior
- `Solid / UI` for read-only and takeover surface behavior inside one client

### Terminal Recovery, Focus, And Restore

Validate these failure patterns:

- `ready` is reported before restore, resize drain, or input drain actually complete
- delta/noop recovery accidentally enters the blocking snapshot lane
- historical output is replayed through the live stream on rebind
- background terminals steal focus while finishing startup
- attach priority or deferred startup makes the active terminal feel blocked
- module-local startup or recovery owners recurse or leak state across tests

Edge cases that are easy to miss:

- typing during recovery, not only after visible readiness
- large-history background tab switches
- reload/restore with warm scrollback
- focused typing while a background terminal redraws heavily
- startup failures that should clear shared progress state instead of leaving stale queued entries

Preferred proof:

- `node / backend` for recovery contract and retained-cursor behavior
- `runtime / integration` for real browser restore/focus/render behavior
- `Solid / UI` for local terminal overlays and shared startup indicators

### Preview, Ports, And Parser Trust

Validate these failure patterns:

- parser output is treated as canonical truth instead of a hint
- shell noise is stripped too aggressively and damages valid URLs
- preview routes lose auth, nested paths, or static assets
- task-owned observed ports and dialog-local scan suggestions get conflated
- preview state hides errors or trust boundaries behind density changes

Edge cases that are easy to miss:

- broken real-world strings next to nearby valid strings
- stale detected ports after task changes
- nested preview paths
- unauthorized and unavailable preview targets

Preferred proof:

- `node / backend` for parsing and routing semantics
- `Solid / UI` when the risk is presentation-only
- `runtime / integration` when auth/bootstrap and real browser navigation matter

### Handler, Typing, And Persistence Boundaries

Validate these failure patterns:

- required request payloads become optional for transport convenience
- optional request channels stop taking their intended default path
- malformed handler input is accepted too late
- shared payload shapes drift across backend, transport, and renderer copies
- persisted-state parsing forks into multiple local parsers
- mocked backend controller responses stop carrying version truth

Edge cases that are easy to miss:

- empty but valid fragments
- legacy agent definitions
- explicit `undefined` versus omitted payloads
- DOM-bearing modules becoming the accidental source of truth for shared types
- resume behavior inferred from args instead of the canonical agent definition

Preferred proof:

- `node / backend` boundary tests first

### High-Churn Product Screens

Validate these failure patterns:

- task, review, preview, or sidebar screens diverge from canonical store/projection owners
- dialogs or leaf chrome silently become task- or app-level workflow owners
- UI summaries drift from the shared projection model
- first-run or reopen flows work in isolation but fail in the full app shell

Edge cases that are easy to miss:

- dialog reopen flows
- local sidebar chrome state persisting separately from shared workspace state
- selection and focus after pushed state changes
- read-only and takeover banners collapsing or re-expanding incorrectly
- review/comment/export workflows drifting across multiple surfaces
- TaskPanel permission flows regressing back into inline component orchestration
- ReviewPanel loading and file-selection state drifting back into direct transport handling

Preferred proof:

- `Solid / UI` first
- add `runtime / integration` when focus, browser bootstrap, or multi-client behavior matters
- add architecture tests whenever a shell component is supposed to remain a pure composition layer

### Notification, Visibility, And Attention Routing

Validate these failure patterns:

- initial bootstrap or reconnect replay is treated like a fresh task-status transition
- notification policy drifts between Electron and browser providers
- browser permission or capability state is assumed instead of modeled explicitly
- same-browser tabs duplicate the same notification burst
- visible peers suppress too much or too little task attention
- hidden/browser-specific notification behavior is validated only in node tests

Edge cases that are easy to miss:

- browser permission moving through `default`, `granted`, and `denied`
- persisted notification preference migrating from older default-off state into the current
  default-on preference model
- Electron runtimes where native notifications are unsupported
- refocus or tab-visibility changes while notifications are still debounced
- multiple tasks becoming ready in one burst
- reconnect finishing while the notification runtime is still disarmed

Preferred proof:

- `Solid / UI` for provider capability state, permission flows, and shared notification runtime
- `Solid / UI` or session-state tests for toggle-on permission requests and legacy preference
  migration when browser defaults change
- `runtime / integration` when real browser visibility, multi-tab dedupe, or multi-client
  suppression is part of the risk
- `node / backend` only for the Electron IPC capability and delivery seam

## Harness Failure Patterns

Shared harnesses need explicit proof when they change. The common failure patterns are:

- timer state leaking across tests
- listener cleanup removing “the current listener for this event” instead of the exact listener
- readiness waits keying off incidental calls instead of the real completion signal
- retained sessions, retry queues, or subscriptions surviving across tests in module scope
- mocks collapsing backend truth to booleans and no longer exercising the real contract

The right fix is usually to improve the harness, not to broaden timeouts.

## Implicit Edge Cases

When you validate a risky area, some edge cases should be treated as implicitly included in the
proof even if the change did not mention them by name.

Examples:

- a startup/persistence change implicitly includes legacy and partial persisted-state handling
- a browser restore change implicitly includes authenticated bootstrap ordering
- a controller or lease change implicitly includes stale-after-clear ordering and versioned mocks
- a remote/mobile collaboration change implicitly includes first-run naming and submit-focus
  release
- a terminal recovery change implicitly includes typing during recovery and large-history churn

If the chosen seam does not make those edge cases visible, add another seam.

## Commands And Operational Workflow

This document intentionally does not try to stay current with every command or browser-lab recipe.

For exact operational workflow:

- use repo scripts and `package.json` as the command source of truth
- use [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) for terminal/browser-lab,
  recovery, profiling, and diagnostics workflow

## What To Update With The Code

If a change teaches a reusable testing lesson:

- update this document when the lesson is about failure patterns, seam choice, or what counts as
  sufficient proof
- update [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) when the lesson is about
  browser-lab workflow, profiler usage, or terminal debugging order
- update [ARCHITECTURE.md](./ARCHITECTURE.md) when the lesson is really an ownership or guardrail
  constraint rather than a testing pattern
