# Browser Bootstrap Redesign

This document defines the browser-first startup contract for Parallel Code.

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first for ownership rules and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the current runtime map. Read
[PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md) for the broader
browser-first product objective: desktop-like responsiveness without desktop-style startup and
restore semantics.

This document owns:

- the split between cold browser bootstrap and reconnect restore
- the startup tiers for browser mode
- what browser startup may block on
- what browser startup must defer
- the startup metrics that matter

This document does not own:

- terminal implementation details
- generic persistence format details
- exact test command lines

## Problem

Browser mode used to pay too much startup cost on first page load because it mixed together:

1. cold browser bootstrap
2. reconnect/session restore
3. terminal continuity recovery

That produced a desktop-style startup shape in a browser shell:

- load saved workspace state up front
- restore broad renderer state before the shell is ready
- let background terminal continuity work leak into the default startup path

The browser-first contract is now explicit instead.

## Target Contract

Browser mode has two different startup paths:

### 1. Cold bootstrap

Use this for:

- first browser load
- new browser tab
- standard authenticated page navigation

Cold bootstrap should:

- render shell chrome quickly
- apply a lightweight server-backed workspace projection
- restore browser-local client-session preferences
- prioritize the selected task and selected terminal

Cold bootstrap must not:

- reuse reconnect restore semantics
- block on hidden/background terminal attach
- treat persisted workspace replay as the only startup truth

### 2. Reconnect restore

Use this only after real reconnect churn.

Reconnect restore may:

- fetch reconnect snapshot state
- reconcile running agents
- restore selected terminal continuity
- notify when sessions ended while the browser was unavailable

Reconnect restore is allowed to do deeper repair work than cold bootstrap, but it must still stay
role-aware and selected-surface-first.

## Startup Tiers

Browser cold bootstrap now progresses through these tiers:

1. `shell`
   - runtime is starting
   - browser startup mode is `cold-bootstrap`
2. `summary`
   - server-backed workspace projection is applied
   - shared server-state bootstrap categories are hydrated
3. `selected-task`
   - browser-local session selection and focused task/task-panel context are reconciled
4. `selected-terminal`
   - the selected visible terminal reports ready first
5. `background`
   - hidden/background terminal attach may resume

The transition into `background` is intentionally downstream of selected-surface readiness. A
timeout fallback exists so browser sessions without a selected terminal, or with a missing
selected-terminal readiness signal, do not block background attach forever.

## Ownership

- backend
  - owns the cold bootstrap payload and reconnect snapshot payload
  - owns server-state bootstrap categories
- workflow / app
  - owns startup mode and startup-tier policy
  - decides when background terminal attach is allowed
- store / projection
  - applies workspace projection state
  - restores browser-local client-session preferences
- presentation
  - renders startup state and terminal loading state

Leaf terminal components may report facts such as readiness, but they must not redefine startup
policy.

## What Browser Startup Applies

Cold bootstrap currently applies:

- projects
- task metadata
- task ordering
- lightweight task summaries from a typed backend-owned projection
- server-state bootstrap categories such as task command controllers, task review, task ports, and
  agent supervision
- browser-local client-session preferences after the shared projection
- browser-local shell panel layout for same-tab reload continuity

Cold bootstrap intentionally does not replay standalone terminal panels from persisted workspace
state. Same-tab browser continuity may restore those panels from browser-local client session
storage, but shared workspace truth still excludes them.

## Metrics

The renderer diagnostics owner now records:

- browser startup mode starts/completions/cancellations
- current startup mode
- current startup tier
- tier entry counts
- cancellation reasons for stale, failed, or superseded reconnect restore and startup work
- last tier timings within the current startup mode
- last cold-bootstrap duration
- last reconnect-restore duration

Use those metrics with the existing terminal startup paint metrics:

- selected logical ready
- selected paint ready
- visible sibling paint ready
- hidden startup work

## Validation

Startup changes should prove:

- cold browser load does not depend on reconnect restore
- browser startup applies the cold bootstrap payload before browser-local session restore
- browser startup no longer depends on `workspaceStateJson` or persisted-workspace JSON parsing on
  the cold-start path
- shared bootstrap categories are still buffered and replayed correctly
- hidden/background terminal attach stays blocked until selected-terminal-first startup finishes or
  the documented fallback completes
- reconnect restore still uses the reconnect snapshot path

Keep proof split across:

- `node / backend` for cold bootstrap payload shape
- `Solid / UI` and owner-local runtime tests for startup-tier and attach policy
- browser/runtime integration only when the change crosses those seams

The repeatable browser-lab harness for startup timings now lives in:

- [tests/browser/browser-startup-metrics.spec.ts](../tests/browser/browser-startup-metrics.spec.ts)

The capture workflow and comparison checklist now live in:

- [BROWSER-BOOTSTRAP-METRICS-2026-04-03.md](./BROWSER-BOOTSTRAP-METRICS-2026-04-03.md)
