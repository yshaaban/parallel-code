# Review Rules

Use this document when reviewing non-trivial changes in Parallel Code, especially:

1. upstream ports and parity work
2. browser-mode transport, auth, reconnect, restore, or persistence changes
3. preview and exposed-port behavior
4. shared test harness changes that can affect suite-order stability

This file is intentionally narrow:

- it is the cross-cutting review checklist and lessons-learned record
- architecture-specific constraints belong in [ARCHITECTURE.md](./ARCHITECTURE.md)
- validation sufficiency guidance and reusable harness rules belong in [TESTING.md](./TESTING.md)
- terminal/browser-lab workflow and debugging guidance belong in
  [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) for ownership rules and
[UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for upstream-port workflow.

## Required Review Pass

For any non-trivial change, review in this order:

1. map the behavior to the local owner:
   - backend
   - handler / transport
   - workflow / app
   - store / projection
   - presentation
2. identify the failure mode if the change is wrong:
   - stale truth
   - replay drift
   - auth / reconnect churn
   - preview / port mismatch
   - suite-order flake
3. choose the validation seam:
   - node / backend
   - runtime / integration
   - Solid / UI
   - docs / sanity only
4. run the full gate after targeted green if the change touches runtime, preview, persistence, or
   shared test harnesses

Do not review a port only by comparing file shape to upstream. Review whether the behavior landed
in the correct local owner.

## Browser Runtime Review Checklist

When a change touches browser mode, explicitly verify:

- reconnect does not start restore before authenticated control traffic is confirmed
- restore and replay do not run on raw socket state alone
- persistence fast paths do not skip required reconciliation side effects
- state that can update through both request/response IPC and sequenced control events carries a
  backend ordering signal
- auth-expired, reconnect, and connected states preserve clear ownership between transport and
  workflow layers

If any of those are unclear, add or update runtime tests before treating the change as
review-ready.

## Preview And Port Review Checklist

When a change touches preview or observed ports, explicitly verify:

- terminal-output parsing is treated as a hint, not canonical truth
- noisy shell fragments are sanitized without trimming legitimate URL syntax
- authenticated preview routing preserves nested paths and static assets
- preview UI density changes do not hide state transitions or error handling
- task-owned observed ports stay distinct from dialog-local scan suggestions

For parser hardening, require both:

1. the broken real-world string
2. a nearby valid string that must stay intact

## Test Harness Review Checklist

When a review uncovers suite-order flake, prefer fixing the harness cause instead of raising
timeouts.

Check for:

- timer state inherited across tests
- background intervals not cleaned up in `finally`
- listener cleanup keyed by channel name instead of listener identity
- tests waiting for weak intermediate signals instead of real completion signals
- async startup work from one test still mutating shared mocks in the next test
- module-local runtime state being reused without an explicit reset seam

If the failure only appears in the full suite, rerun the smallest affected file first, then fix
the harness cause before broadening timeouts.

## IPC And Persistence Review Checklist

When a change touches invoke typing, handler validation, or persisted-state parsing, explicitly
verify:

- required request channels stay exact in the shared request map instead of being widened for
  transport convenience
- optional request channels are explicit and mirrored by the handler-side allowlist or guard path
- malformed handler input is classified as `BadRequestError`, not a generic internal error
- repeated saved-state fragments are parsed through one shared parser or type source instead of
  local `JSON.parse(...) as ...` copies
- full-state and workspace-state persistence still use the same canonical task and terminal
  serialization/hydration helpers
- task removal and incremental workspace reconciliation still clear task-scoped derived state
  through the shared cleanup authority
- restore paths only tolerate partial persisted fragments where the canonical parser says they
  should
- shared transport/domain payload types live in DOM-neutral modules, not in browser runtime files
  that touch `window`, `document`, or Solid runtime helpers
- agent resume behavior stays canonical in the shared agent definition shape instead of drifting
  into UI or workflow heuristics

If any of those drift, add or update direct node tests before treating the change as review-ready.

## Standing Lessons

### 1. Restore waits for authenticated control traffic

A raw websocket `connected` event is not enough to treat browser restore as safe.

- start browser restore from confirmed authenticated control traffic, not from transport open alone

### 2. No-op persistence paths must preserve reconciliation side effects

Skipping an identical persisted payload is fine only if required validation, refresh, and repair
work still runs.

- if a sync path becomes a no-op for durable state, re-check whether reconciliation side effects
  still need to run

### 3. Exact IPC request shapes stay exact

Loosening shared request typing for transport convenience hides real request-shape drift and turns
missing payloads into late runtime failures.

- keep required request payloads required in the shared invoke map and reject missing required
  payloads as bad requests at the handler boundary

### 4. Shared persisted fragments get one parser

When multiple restore paths parse the same saved-state fragment independently, they drift quietly
and recover different subsets of state.

- if more than one path needs the same persisted fragment, parse it once through a shared parser
  and reuse that canonical shape everywhere

### 5. Cross-plane live state needs backend ordering

When the same live state can update through fetch/invoke responses and sequenced control-plane
events, arrival order in the renderer is not trustworthy.

- version or sequence backend snapshots themselves and ignore stale renderer updates at the
  store/projection boundary

### 6. Listener cleanup must be identity-aware

If a test mock removes listeners by event name only, stale async cleanup from one test can delete
the next test's listener and create non-reproducible timeouts.

- shared harness cleanup for listeners should remove only the exact listener that was registered

### 7. Wait for real completion signals, not incidental calls

The first observed call in a startup chain is often too early to prove the behavior the test claims
to assert.

- choose the readiness assertion that matches the behavior under review, not the earliest call in
  the chain

### 8. Module-local runtime owners need explicit reset seams and safe no-op updates

Workflow and transport modules often keep runtime state outside the main store. Those owners are
easy to review incorrectly because isolated tests may pass while the full suite reuses stale state.
Effect-driven no-op writes can also self-subscribe if they read the same signal outside the setter.

- if a module keeps runtime state outside the store/backend, give tests an explicit typed reset seam
- for effect-driven signal owners, read the current entry inside the setter callback and return the
  previous object on missing or unchanged writes

### 9. Diff hot paths should be fixed at the backend owner first

When review diff behavior is wrong or slow, the first question is which backend git path is being
used, not which renderer surface noticed it.

- keep review and non-review diff semantics on one backend-owned path
- pass existing changed-file metadata down to the backend instead of re-deriving intent in the UI
- profile subprocess fan-out before adding renderer-side caches or heuristics

## What To Update With The Code

If the change is non-trivial, update the deeper source-of-truth docs in the same branch:

- [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and guardrail changes
- [TESTING.md](./TESTING.md) for reusable validation or harness guidance
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) for terminal/browser-lab
  workflow and debugging guidance
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for upstream parity status

The goal is to leave behind a reusable rule in the right document, not a one-off bug diary in the
review checklist.
