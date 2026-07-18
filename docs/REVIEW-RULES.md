# Review Rules

Use this when reviewing non-trivial Parallel Code changes, especially:

1. upstream ports and parity work
2. browser-mode transport, auth, reconnect, restore, or persistence changes
3. preview and exposed-port behavior
4. shared test harness changes that can affect suite-order stability

This file stays narrow:

- it is the cross-cutting review checklist and lessons-learned record
- product pain taxonomy and product-level validation objectives belong in
  [PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md)
- architecture-specific constraints belong in [ARCHITECTURE.md](./ARCHITECTURE.md)
- validation sufficiency guidance and reusable harness rules belong in [TESTING.md](./TESTING.md)
- terminal/browser-lab workflow and debugging guidance belong in
  [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)

This document owns:

- review order and review questions
- cross-cutting lessons that are still useful after the specific bug is fixed

This document does not own:

- the current runtime map
- validation policy and quality gates
- terminal/browser-lab runbooks

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) for ownership rules and
[PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md) for the user-frustration
frame. Read [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for upstream-port workflow.

## Required Review Pass

For any non-trivial change, review in this order:

1. map the change to the user frustration and product objective it protects
2. map the behavior to the local owner:
   - backend
   - handler / transport
   - workflow / app
   - store / projection
   - presentation
3. identify the failure mode if the change is wrong:
   - stale truth
   - replay drift
   - auth / reconnect churn
   - preview / port mismatch
   - suite-order flake
4. choose the validation seam:
   - node / backend
   - runtime / integration
   - Solid / UI
   - docs / sanity only
5. run the full gate after targeted green if the change touches runtime, preview, persistence, or
   shared test harnesses

The pull request template and PR-description CI check follow this order. The check only verifies
that the required fields exist. Reviewers still decide whether the product pain, owner, validation
seam, and browser-lane rationale are correct. If a change is reviewed outside GitHub, use the same
product frustration / owner / validation / browser-lane fields in the notes.

Do not review a port only by comparing file shape to upstream. Review whether the behavior landed
in the correct local owner.

## Browser Runtime Review Checklist

When a change touches browser mode, explicitly verify:

- cold browser bootstrap stays distinct from reconnect restore
- the cold-bootstrap handler stays free of process spawns and availability probing; agent defs
  ship with last-known sticky availability and probes run only as background work-queue jobs
- speculative startup prewarms must be identity-keyed (exact task and agent) and confirmed or
  discarded before the selected-task tier is announced; speculation never mutates store state
- reconnect does not start restore before authenticated control traffic is confirmed
- restore and replay do not run on raw socket state alone
- browser startup does not unblock hidden/background terminal attach before the selected surface is
  ready or the documented fallback fires
- visible non-shell startup attach and visible shell attach are different contracts: the former
  uses `GetTerminalStartupRecoveryBatch`, the latter stays on ordinary attach with rendered-tail
  suppression, and hidden attach remains ordinary attach
- persistence fast paths do not skip required reconciliation side effects
- state that can update through both request/response IPC and sequenced control events carries a
  backend ordering signal
- auth-expired, reconnect, and connected states preserve clear ownership between transport and
  workflow layers

If any of those are unclear, add or update runtime tests before treating the change as review-ready.

## Preview And Port Review Checklist

When a change touches preview or observed ports, explicitly verify:

- terminal-output parsing is treated as a hint, not canonical truth
- noisy shell fragments are sanitized without trimming legitimate URL syntax
- authenticated preview routing preserves nested paths and static assets
- preview UI density changes do not hide state transitions or error handling
- task-owned observed ports stay distinct from dialog-local scan suggestions
- task container previews stay distinct from observed ports, exposed ports, and dialog-local scan
  suggestions
- opening or focusing preview consumes the current task-port snapshot first; expensive listener
  scans stay behind an explicit rescan action or another documented one-time policy
- opening the preview manager must not silently start task containers unless that policy is
  explicitly documented and tested
- task container running/support state comes from backend inspect truth, not local UI inference
- task container lifecycle actions (`inspect`, `start`, `stop`, `destroy`, `logs`) remain
  task-scoped backend truth keyed by canonical container identity
- task-panel preview workflow owns `inspect` / `logs` / lifecycle sequencing, stale-request
  suppression, and explicit error state; presentation only renders that workflow-owned state
- fresh inspect truth must clear stale task-action error state instead of leaving the UI in a
  mixed old-error/new-truth state
- stop and destroy semantics must be proven against canonical Compose identity, not just command
  shape or mock call assertions

For parser hardening, require both:

1. the broken real-world string
2. a nearby valid string that must stay intact

Task container review rule:

- `Project.containerConfig` is durable repo/project truth
- container inspect/runtime/log state is ephemeral backend truth
- do not persist container running/support state into store truth or let dialogs/components own
  container lifecycle policy
- changes to task-container lifecycle execution, identity, cleanup, or preview derivation require
  the dedicated real Docker integration proof (`npm run test:node:docker:integration:required`)
  plus mocked backend tests and UI wiring proof

## Test Harness Review Checklist

When a review uncovers suite-order flake, fix the harness cause instead of raising timeouts.

Check for:

- timer state inherited across tests
- background intervals not cleaned up in `finally`
- listener cleanup keyed by channel name instead of listener identity
- tests waiting for weak intermediate signals instead of real completion signals
- `waitFor(() => screen.getBy...())` loops on transient loading states that can repeatedly format
  the DOM while failing
- async startup work from one test still mutating shared mocks in the next test
- module-local runtime state being reused without an explicit reset seam
- browser-lab render tests that need diagnostics or lifecycle capture should use the shared
  harness `openSession(...)` path instead of raw `browser.newContext()` so teardown and artifact
  capture stay unified
- after `page.bringToFront()`, browser-lab terminal tests must not trust stale
  `document.activeElement`/`document.hasFocus()` alone; hidden-tab round trips can leave the DOM
  looking focused before the terminal surface has really reacquired keyboard ownership

If the failure only appears in the full suite, rerun the smallest affected file first. Fix the
harness cause before broadening timeouts.

For browser performance cases, isolate a proven shared-browser-process contamination issue into its
own Playwright invocation while keeping the assertion in the default scripted gate. Do not weaken
the assertion or convert it into a soak-only check because Chromium reuse is noisy.

When browser build freshness is under review, keep the owner split explicit:

- runner scripts may auto-prepare stale browser artifacts once before Playwright starts
- the standalone harness must still reject stale or missing browser artifacts as a backstop
- freshness roots must cover the complete production dependency closure: value imports for Vite
  bundles and every compiled or typechecked input for the production TypeScript server build; keep
  this mapping under an import-closure guard so new cross-boundary dependencies cannot silently
  leave an artifact stale, and do not make Vite artifacts stale for type-only imports they omit
- do not key freshness to whole-file `package.json` mtime when only a narrower build input, such
  as the shipped app version, is actually required
- for Electron releases, classify Vite-only renderer packages as build-time dependencies, not Node
  runtime dependencies; verify the archive against every recursively packaged output/runtime tree
  and the lockfile rather than representative entrypoints, because a fresh `index.html` or
  `main.js` does not prove that sibling chunks and backend modules are fresh
- verify every archive produced by a multi-platform or multi-architecture release, and require the
  complete set of unique non-development, non-optional locked name/version identities plus
  declared direct dependencies in each archive; match transitive packages by identity instead of
  installation path so legitimate hoisting does not create false failures, and do not treat one
  unpacked target or a handful of direct entrypoints as representative
- production server compilation must start from an empty output directory and use a build-only
  tsconfig that excludes tests and test helpers; scan the emitted tree for development artifacts
  and test-runner imports, remove failed partial emits, and keep the broader server tsconfig for
  test-aware typechecking instead of trading release cleanliness for weaker checks; every standard
  non-watch harness build must route through that owner instead of emitting the broad config into
  the already-validated production directory

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
- task deletion response payloads stay typed across Electron IPC and browser HTTP IPC; cleanup
  warnings must not be erased by treating a successful delete response as `undefined`
- task and terminal close workflows remove renderer state promptly after runtime cleanup and persist
  that removal best-effort, instead of relying on delayed animation timers that can reload stale
  entries
- restore paths only tolerate partial persisted fragments where the canonical parser says they
  should
- shared transport/domain payload types live in DOM-neutral modules, not in browser runtime files
  that touch `window`, `document`, or Solid runtime helpers
- agent resume behavior stays canonical in the shared agent definition shape instead of drifting
  into UI or workflow heuristics
- every coordinator mutation producer enters one lifecycle owner, including direct run/activity
  commands and final task deletion/state-removing cleanup; close admission before draining, retain
  deadline-detached rollback work, and bind browser requests to the lifecycle that owns their state
  directory so an old request cannot write after an in-process replacement
- a shutdown persistence owner takes one unconditional current-state snapshot after mutation
  producers drain and after every older queued write; do not infer durability solely from an event-
  driven dirty bit, and do not normalize the final write rejection into successful cleanup
- cleanup boundaries attempt every independent owner, then preserve the aggregate failure for
  callers and process status; logging a rejection while returning a fulfilled public wait or exit
  status `0` is not failure propagation
- model operation and cleanup outcomes with an explicit fulfilled/rejected discriminator. `null` or
  `undefined` cannot be a "no failure" sentinel because JavaScript promises may reject with either;
  filtering rejection reasons by value silently converts real cleanup failures into success
- when `finally` collects cleanup errors, do not `return` from its paired `try`: JavaScript resumes
  that pending return after `finally` and skips post-cleanup checks. Stage the operation result,
  compose operation and cleanup outcomes afterward, and include top-level browser/context closure
- process-backed request registries count terminating owners until bounded cleanup actually settles;
  deleting the current request-id projection during cancel/replacement must not free concurrency or
  make that process invisible to Electron and browser-server shutdown
- an `AbortSignal` transport API must settle its consumer promptly in every runtime; Electron cannot
  retract already-admitted backend work, but waiting for that IPC promise before observing abort
  retains stale reactive closures and makes the browser and Electron contracts diverge
- app-owned buffered and streamed runtime subprocesses use the shared bounded process owner; Node's
  direct-child timeout is not a completion or descendant-tree deadline, so the owner must reject
  pre-aborted work before launch, create an owned POSIX process group (or tracked Windows
  tree-kill), discover descendants that escape into another process group/session, retain verified
  process identities across a bounded cleanup retry, terminate every owned group, escalate to a
  forced kill, verify the tree is absent, and detach streams/listeners on every outcome; Windows
  cleanup must await its tree request even when the root already exited; on POSIX, snapshot ownership
  during startup output/readiness rather than waiting for stop, because the root can exit first;
  consumers may ignore only the exact rejection created by their own confirmed termination request,
  and must propagate the bounded owner's forced-settlement error instead of converting unconfirmed
  process-tree cleanup into a successful fallback;
  prove non-closing children with fake time and prove a real detached, uncooperative descendant is
  gone with an OS-level test
- subprocess error decoration must tolerate immutable external errors; buffering stdout/stderr is
  useful diagnostic enrichment, but it must never throw instead of settling the owning promise
- runtime Git commands stay behind the diagnostic Git wrappers: buffered and streamed calls use the
  bounded owner, while unavoidable synchronous calls receive the shared timeout policy and expose
  the nullable result produced by ignored stdio instead of promising output that does not exist

If any of those drift, add or update direct node tests before treating the change as review-ready.

## Arena Competitor Review Checklist

When a change touches arena competitor launch or readiness, explicitly verify:

- competitor availability and auth/env status come from backend inspect truth, not renderer PATH or
  local-storage heuristics
- preflight and battle execution share one direct-executable parser/materializer contract, with
  shell wrappers and env prefixes rejected before `Fight!`
- browser-first shells classify missing command or missing auth before `Fight!` is allowed
- quiet non-interactive competitors are warned as such instead of being treated as launch failures
- battle surfaces only render preflight warnings already classified by the backend; they should not
  infer their own readiness state from empty terminal output or drift back to `/bin/sh -c`

If any of those are unclear, add or update direct backend and arena-screen tests before treating
that change as review-ready.

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
- a click on one file must fetch that file's diff directly instead of hydrating a whole-task patch

### 10. Shell startup attach is not the same contract as non-shell visible startup attach

Do not collapse the shell attach policy into one broad snapshot-first rule.

- visible non-shell startup attach uses the dedicated startup batch path
- visible shell attach stays on ordinary attach with rendered-tail suppression
- hidden shell reload attach is reveal/prewarm-gated; when it does attach, it still uses the
  ordinary attach path
- large-history shell browser cases are the maintenance-critical proof for this split

### 11. Preview-controller failures must surface explicitly

If preview inspection or lifecycle requests reject, the controller must not hide the failure by
just clearing loading state.

- inspect, logs, and lifecycle action rejections must surface explicit task-scoped error state
- stale action error state should clear after fresh inspect truth arrives

### 12. Scoped Vitest runs should use the repo timeout wrapper

Detached or orphaned ad hoc Vitest runs are easy to miss, especially during iterative UI work.

### 13. Upstream parity claims must be verified on current main

Upstream review can be misled by old branches, abandoned experiments, or historical merge commits
that never became part of the current product tree.

- do not mark an upstream commit as covered just because a similar commit exists somewhere in repo history
- verify coverage on current `main`, or point to the exact current owner files that now carry the behavior

### 14. Cleanup and projection rules belong at the owner seam

When a workflow or projection keeps temporary local state, review the full ownership boundary, not
just the inner happy path. Cleanup and reconciliation should happen where the owner can see the
whole operation, including late failures and mixed entity types.

### 15. Shared entrypoint policy must stay single-sourced

If multiple runners or entrypoints expose the same skip, freshness, auth, or readiness contract,
keep that rule in one canonical owner and make the wrappers compose it instead of reinterpreting
it locally.

- use `npm run test:node:file -- ...` or `npm run test:solid:file -- ...` for targeted runs
- avoid raw `npm exec vitest ...` when the repo wrapper can provide timeout and process-tree cleanup
- when Solid/jsdom files are stable alone but drift together, isolate them in the scoped runner
  rather than normalizing shared-worker timing flakiness as product behavior
- if a leaf-component test is flaky because it is proving state owned by a helper/runtime module,
  move the detailed state assertions to the owner seam and keep the leaf integration check minimal

### 16. Replacement restores must win before queued output drains

Reconnect recovery can queue a second restore while the first restore is still settling. If live
output is allowed to flush in the handoff window, the replacement restore can replay against
already-drained bytes and quietly duplicate or reorder output.

- when a reconnect restore is superseded, start the replacement restore before scheduling queued
  output flushes
- add a focused runtime test that proves queued output does not drain between the stale restore and
  the replacement restore

### 17. Process-driven harness readiness must survive chunking and failed startup

Server and harness tests often discover readiness from child-process stdout. That path is easy to
review too casually: logs arrive in chunks, and failed startup waits can otherwise leave a live
child process behind.

- accumulate stdout across chunks before matching readiness lines
- when startup readiness fails, stop the spawned process and clean temporary test state in the same
  failure path

### 18. Sibling surfaces with the same intent must share one backend path

The recent slow-diff bug was not a raw performance problem. It was an ownership drift problem:
sibling surfaces that looked equivalent were routing the same user intent through different backend
query paths.

- when two surfaces expose the same task-level intent, identify the one canonical backend/query
  path first and verify both surfaces use it
- do not let optional UI props silently choose between canonical task truth and ad hoc local fetches
- add at least one targeted test or architecture guard that proves the sibling surfaces stay aligned

### 19. Local open and focus should not imply whole-system work

Open and focus transitions are easy places for renderer convenience to drift into hidden expensive
backend work.

- opening a local surface should render from current canonical snapshot/projection state first
- if a whole-host or whole-project scan is still required, make it explicit in workflow policy and
  prove that it happens only when intended

### 20. Transitional lifecycle UI must have a live owner and exit path

Many recent terminal/browser bugs were not wrong steady states. They were transitional states that
outlived the owner that was supposed to clear them.

- do not surface `restoring`, `reconnecting`, `flow-controlled`, read-only, or similar
  transitional UI unless one runtime/backend owner is actively responsible for clearing it
- do not let terminal cursor affordances outlive the same ownership contract: if render, resize, or
  recovery truth is not current yet, the blinking cursor must not keep advertising stale input
  readiness
- review the clear path at the same time as the enter path
- add one deterministic churn test for repeated enter/exit cycles, not just a one-shot happy path
- for browser-visible states, add one assertion that the UI is operationally ready again, not only
  visually settled

### 21. Stress tests should fail on invariant leaks, not just missing copy

Manual smoke often finds bugs that look like “it still says restarting/restoring” or “the prompt
is back but typing does nothing”. Those are invariant failures across owners.

- browser stress helpers should capture enough owner state to explain which invariant leaked:
  supervision, controller ownership, transport/lifecycle banner, and terminal DOM state
- prefer reusable invariant assertions over one-off timeout waits
- when a browser scenario proves a cross-owner lifecycle contract, keep the lower-seam deterministic
  churn test too

### 22. Backend mirrors of persisted state must track the current codec shape

Registry-style backend mirrors are easy to leave on an old persisted field name while the canonical
codec evolves somewhere else. That silently drops metadata even though the runtime still has it.

- when a backend mirror parses persisted task or session state, verify it accepts the current codec
  field shape first and only keeps legacy field names as backward-compatible fallback
- when workflow-owned create/update paths already know task metadata that the backend mirror needs,
  pass it through the owning request/registry seam instead of hoping persistence catches up later

### 23. Remote triage surfaces should show backend-owned actionability, not renderer recency

Remote/mobile list rows are control surfaces. They should help the user decide which task to open
or take over next, not simply replay generic "recently active" status text.

- remote/mobile row badges should come from canonical pushed backend state like supervision,
  task-review, task-ports, and task-command ownership
- avoid recency timers or vague activity labels as primary row metrics when the backend already
  knows waiting, ready, blocked, conflict, or preview state
- transport validation should reject malformed or forward-incompatible remote payloads before they
  can crash presentation logic or silently widen UI state

### 24. Presence cues are not controller locks

Remote presence is valuable for triage, but it is still a softer hint than controller snapshots. If
one surface promotes presence fallback into a blocked/read-only state while another waits for
controller truth, the UI will disagree about whether the task is actually locked.

- blocked counts, takeover warnings, and read-only gating should come from task-command controller
  snapshots
- presence-only ownership can still be shown as a softer cue, but it needs a distinct label/tone
  so it cannot be confused with a confirmed lock
- add a focused test that presence-only state does not increment blocked counters or reuse the same
  warning label as a controller-confirmed owner

### 25. Task steps must stay backend-owned and lazily projected

The steps surface is shared worktree truth, not renderer-owned task metadata. If one layer starts
polling `.claude/steps.json`, persisting full history inside `Task`, or treating tab-local prompt
prefill as shared state, multi-client behavior will drift quietly.

- `electron/ipc/task-steps.ts` owns `.claude/steps.json` watching, normalization, timestamp repair,
  and replayable summary events
- `Task.stepsTracking` is durable config only; full step history stays in the worktree file and
  backend projection state
- browser cold bootstrap should replay compact step summaries only; full history must stay lazy so
  startup does not regress
- `src/app/task-steps.ts` owns prompt seeding, next-action prefill, and jump behavior; leaf task
  panels should not recreate those workflows inline
- add focused tests for explicit `false` persistence, stale step-snapshot cleanup on full-state
  restore, and bootstrap-before-live-event ordering for the `task-steps` replay category

### 26. Destructive cleanup warnings are part of the contract

Deleting a task has two user-visible outcomes: the task should close, and best-effort cleanup may
still report leftovers such as agent runners, containers, worktrees, or branches.

- return cleanup warnings through the typed IPC payload from both managed-worktree deletion and
  state-removing runtime cleanup instead of throwing or erasing them after user-facing runtime
  state has been released
- await asynchronous runner cleanup before reporting the destructive workflow complete; keep a
  failed cleanup owner reachable so a transient infrastructure failure can be retried
- attempt independent cleanup resources even when one fails, and aggregate the failures instead of
  abandoning later cleanup
- when an external resource is prepared before final spawn admission, dispose it if admission
  closes or another caller already created the session; the spawn result must distinguish resource
  creation from merely attaching a new output channel
- surface the warning once in the workflow owner
- do not keep the task in a transitional close state just because a secondary cleanup step failed

### 27. Terminal cleanup must be identity-aware

Terminal sessions can remount while old callbacks are still unwinding.

- clear focus or ready callbacks only when the cleanup still refers to the registered callback
- guard late timers and input-feedback callbacks during unmount
- test stale callback paths directly instead of relying only on broad browser restore coverage

### 28. Transport ring compaction is only legal for full-replace snapshot keys

The control-event replay ring may compact (latest-wins per key) only message classes whose every
event is a complete replacement for that key. A key whose consumers depend on intermediate deltas
must never compact, or replay silently drops state transitions.

- new compaction keys require a contract test proving no intermediate-delta consumer exists
- tombstones must share the entity's key so removal supersedes the earlier upsert in the ring
- batched replay consumers must adopt the frame's `toSeq` wholesale; per-event gap detection is
  wrong for compacted (legitimately non-contiguous) replayed seqs
- per-event (legacy) replay is only legal for gap-free windows: a compacted or evicted window
  must degrade to the `replay-truncated` signal instead of a holey per-event replay, and the
  shared client core adopts that signal's `latestSeq` wholesale — otherwise gap-detecting
  consumers (the remote shell hard-reconnects on gaps) loop forever on their own reconnect churn

### Additional terminal and lifecycle lessons

Terminal perf claims need proof in the lane and layout they claim to improve. A browser run can
look realistic and still miss the policy under review, so verify the claimed lane is active, sweep
the relevant visible-set shapes when layout changes the tradeoff, and do not promote a candidate on
one metric or one convenience profile alone.

If app workflow mirrors a store preference, keep the preference in the store layer and the
runtime-facing mirror in the app owner, then sync and reset that mirror explicitly from store
writers, restore paths, and shared test resets.

If a store field is bootstrap-backed, omission in persisted state is not the same thing as an
explicit `false`. Preserve the current runtime-backed value unless persisted state provides a real
override, and add a regression test that restores legacy or omitted state from a non-default
bootstrap.

Presentation-only terminal mirrors still need streaming UTF-8. Overlay-only corruption is still a
real bug, so decode incrementally and add at least one regression test that splits a multibyte
character across chunk boundaries.

Hot-path diagnostics must no-op when disabled. If diagnostics code is allowed in a scheduler,
decoder, or write path, the disabled path must stay cheap and directly testable.

Server agent-status snapshots must be allowed to revive a locally stale `exited` agent when the
backend reports a live state again. Treat lifecycle `exit` events as strong evidence, but not as an
irreversible local terminal state, because reconnect or out-of-order client events can otherwise pin
the UI on "Restart" while the process continues running.

When agent restarts are modeled as client-side generations, late exit callbacks from an older
generation must not be allowed to overwrite the current generation's running state. Capture the
generation at the terminal owner seam and ignore stale exits that arrive after a restart or agent
switch.

Do not rely on reactive effects to resync session-owned state when terminal attach is scheduler
driven. `TerminalView` creates `session` as a plain local owner, so a delayed attach will not rerun
focus/WebGL/output-priority effects by itself. Apply the current session runtime state immediately
when the session is created, then let the reactive effects handle subsequent changes.

Output-based revival of a stale `exited` agent must be generation-bound, not heuristic-only. Late
buffered output from an older generation can arrive after a real exit, so only the terminal owner
that knows the current generation should be allowed to use output as evidence that the process is
still live.

Prompt/question state must use one canonical tail interpretation across backend supervision,
renderer-side activity analysis, and shared question helpers. A bare trailing prompt line should
clear `waiting-input`, but prompt-adjacent interactive choice tails such as Hydra selection prompts
must still count as waiting even if the operator prompt is already visible. If one layer treats the
prompt as cancelling the question while another keeps the interactive choice active, task status
and prompt affordances will drift silently.
Renderer-local typing echo is not prompt readiness: if the renderer knows a specific agent is
currently receiving local typing echo, prompt-like tails for that same agent must not surface as
`waiting-input` or `ready-for-next-step` until the typing window clears.

Task attention and task activity are not the same signal. If the UI exposes both, review them with
different questions:

- attention: what needs user action or intervention?
- activity: what is the task doing right now?

Do not let activity aggregation reuse attention-style urgency ordering when another terminal in the
same task is actively streaming output. Live output should beat unrelated waiting/startup cues,
while exceptional failure/recovery states can still stay explicit.

Time-windowed UI state is not self-invalidating. If a projection uses `Date.now()` windows for
labels such as `Sending`, `Live`, or similar short-lived badges, require an explicit reactive clock
or timer owner and a fake-time test that proves the label expires even when no unrelated store
state changes. When the time window is tied to an agent lifecycle, bind it to generation or clear
it on exit/restart so stale windows cannot bleed into the next session.

Do not discard queued local terminal continuity just because recovery starts. Attach,
backpressure, and hibernate restores should drain queued local output before the recovery request
so the backend and renderer agree on the current tail, but reconnect replacement restores must keep
that queued tail intact until the replacement restore wins. Otherwise the client can quietly snap
backward, duplicate bytes, or reorder live output during reconnect churn.

Do not let non-live terminals keep resize authority during a viewport resize burst. Visible or
focused terminals may need the latest PTY geometry immediately, but passive or hidden surfaces
should only retain the newest pending size and flush it when they become live again; otherwise one
window resize can explode into backend redraw churn that shows up as focused-terminal flicker.

Do not let managed xterm fits outrun live resize authority. Coalescing PTY resize commits is not
enough if `fitAddon.fit()` still runs across every attached terminal during the same viewport
burst: the renderer will locally reflow stale pages before the backend/TUI settles, which shows up
as resize flicker even when PTY resize counts look healthy. Managed fit owners must respect the
same live/eligible seam as resize commits and flush deferred dirty geometry only when the terminal
becomes live again.

Do not use task selection as a proxy for terminal geometry liveness. In tasks that mount multiple
terminal views, `selected task` is broader than `focused or actually visible terminal`; if resize
or fit ownership keys off selection, hidden siblings in the active task will still participate in
viewport churn and reintroduce redraw flicker.

Task-scoped switch windows must stay task-scoped even when multiple terminal views are mounted for
the same task. Sibling views may register or unregister their participation in the shared switch
window, but one sibling unmounting must not cancel another sibling's active protection window. For
task-panel terminals, own the switch-window lifecycle at the task owner seam and let leaf terminal
views only report readiness/recovery into that shared task window.

Selected task is not enough to keep a terminal render-live. Hidden siblings in the active task
must tier as hidden unless they are also actually visible, focused, or explicitly protected as
the active switch target; otherwise render hibernation stays disabled for terminals that are not
on screen.

Stable startup copy must be a source-of-truth decision, not a leaf-only patch. If the terminal
overlay uses a stable loading label such as `Preparing terminal…`, shared startup summaries and
task/sidebar badges must not keep surfacing phase-specific primary labels like `Connecting`,
`Attaching`, or `Restoring`, or the layout-shift regression just reappears through another UI
surface.

Shell reuse must be prompt-ready, not merely quiet. Reusing an existing shell terminal because it
looks locally idle can race with in-flight output and misroute a new command into the wrong shell
state; workflow code should require an explicit prompt-ready signal from the shell tail before it
reuses that session.

Performance tooling must use the same structural loading contract as the runtime. Browser
profilers and gates should key off `data-terminal-loading-overlay`, `data-terminal-status`, and
`data-terminal-live-render-ready`, not the current human-readable loading copy.

Selected-terminal recovery protection must be generation-safe. If a reconnect or attach restore is
replaced mid-flight, stale restore cleanup must not settle task-scoped recovery guards that belong
to the newer restore. Otherwise switch-window protection can clear early and reopen the same
continuity/flicker bug the replacement restore was supposed to prevent.

Browser restore pauses must be transaction-safe. Batched recovery pauses are server-owned under a
unique `batchPauseId`, and every request holds its own pause even when the agent is already paused
(restore pause leases stack), so one client's release cannot expose another client's pre-apply
window. A stale or duplicate release is a no-op against a newer pause. The client releases each
held pause exactly once after apply — a single restore can hold several ids when geometry-mismatch
re-fetches or `tail-needed` phase two mint additional pauses — and the 5s auto-resume is a safety
net sized above worst-case replay apply (capped snapshots keep apply in the tens of milliseconds),
not the primary mechanism. The auto-resume bounds stall time, not correctness: initial-attach
applies can be deferred past the timer by startup paint/fit gates, which is safe only because the
attach ordering guarantee makes queued output strictly post-cursor and the renderer keeps it
instead of dropping it. Non-batched scoped pauses still carry a restore lease id and must ignore
stale resume ids from older restores on the same channel. A fixed timeout alone is not enough
proof for slow network or large-history recovery.

Server status snapshots are weaker evidence than lifecycle exits unless the local exit itself is
explicitly uncertain. Without a backend ordering token, a non-exited snapshot must not blindly
revive a locally exited agent; only exits caused by temporary server loss, such as
`server_unavailable`, should be treated as revivable from a later live snapshot.

Resize settle windows should survive mixed invalidation. Once a fit owner enters a resize settle
window, later font/theme/intersection dirties must not clear that pending resize timestamp before
the settle deadline expires, or mixed invalidation will quietly bypass the resize coalescing logic.

Natural shell exit should clear activity immediately. Shell reuse and bookmark dispatch treat
activity as reuseability, so leaving a naturally exited shell marked busy until an idle timeout
expires causes avoidable shell churn and inconsistent reuse behavior.

Temporary command-dispatch busy marks are not the same as full activity teardown. If a prompt send
or shell-reuse attempt fails before new output arrives, undo only the transient busy/timer state;
do not clear tails, last-output timestamps, or prompt-analysis state that still describe the live
terminal continuity.

Extra visible terminal surfaces should default to `passive-visible`. In multi-terminal task
layouts, leaving unfocused visible siblings on ad hoc “extra live” policies reopens resize-time
buffer reflow and flicker regressions even when PTY resize commits are already coalesced.

Do not treat the entire terminal experiment matrix as shipped behavior. The production scheduler
contract should be explainable from the built-in High Load Mode profile and its exact-count visible
tables; denser overload families and one-off per-priority override knobs need explicit proof before
they become product defaults.

Terminal presentation must be truthful and input-safe. A terminal surface may show only live truth
or explicit loading/error state. If the presentation is `loading`, the xterm container must stay
masked and stdin must stay disabled. Visible unfocused terminals may be deprioritized by scheduler
tier, but they should remain on the real terminal surface instead of being replaced by synthetic
placeholder UI.

Request-tracked browser terminal input must wait for backend acceptance, not just websocket send
success. If the renderer drops a batch as soon as it reaches the browser transport, task-control
denials and reconnect races can silently lose the first typed foreground command after restore or
tab switching.

Transient task-command lease loss must not discard queued terminal input. When the browser control
plane is temporarily unavailable, the terminal input path should retry after transport recovery
instead of clearing buffered input as if a peer takeover had already been confirmed.

Task-command lease identity must come from the authenticated transport or browser client-id header,
not request JSON. In particular, pagehide releases cannot use `sendBeacon` when the server needs a
custom identity header.

Terminal input latency review should separate three seams: batching policy, backend acceptance, and
visible terminal echo. Exact burst-window policy belongs in unit/runtime tests. Browser multi-char
typing tests should prove user-visible responsiveness without assuming an accepted input batch
appears as one atomic output chunk.

Typing-priority ownership must stay centralized. If one terminal is supposed to be latency-critical,
keep that truth in an app/runtime owner and make output scheduling plus fit/layout work consume it.
Do not let input, output, and fit each grow separate "focused terminal" heuristics, or later
visible-sibling regressions become impossible to reason about.

Recovery retry limits must not silently promote the terminal back to ready while skipping replay.
When restore or reveal logic can run in hidden tabs, any frame-settle wait needs a hidden-tab-safe
fallback instead of assuming `requestAnimationFrame` will fire promptly.

Transitional lifecycle UI must not outrun the owner that clears it. If a reconnect, restore, or
automatic pause transition depends on a later owner to finish the work, keep the earlier visible
state until that owner actually starts.

- reconnect banners should stay in `reconnecting` until authenticated control traffic confirms
  restore start
- when an automatic pause clears, reclassify from the saved tail instead of falling back to a
  generic busy/active state

Bounded chunk histories and output-drain queues must make front trimming amortized. Repeated
`Array.shift()` turns small terminal/control chunks into quadratic work; re-slicing or periodically
flattening a large retained head during append has the same failure mode after restore. Use a head
cursor for transient drain queues and fixed writable blocks (or an equivalent deque/ring) for byte
history, bound discarded storage and metadata, and compact only at an amortized threshold. Prove
exact retained suffix, caller-buffer isolation, replacement followed by many small appends, tail
reads, repeated compaction, and an independently queued small-control-chunk drain. This is a
storage-shape optimization; it must not change terminal pacing, byte order, flow control, or
recovery budgets.

## What To Update With The Code

If the change is non-trivial, update the deeper source-of-truth docs in the same branch:

- [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and guardrail changes
- [TESTING.md](./TESTING.md) for reusable validation or harness guidance
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) for terminal/browser-lab
  workflow and debugging guidance
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for upstream parity status

The goal is to leave behind a reusable rule in the right document, not a one-off bug diary in the
review checklist.

- When a regression is primarily timing-, recovery-, or render-sensitive, lock it first at the runtime or browser seam; component tests should be narrow smoke locks, not the main proof.
- Avoid duplicating the same startup/status behavior across several UI tests. Keep one projection truth test and only the minimum distinct presentation smoke tests.
