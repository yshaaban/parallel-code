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
- opening or focusing preview consumes the current task-port snapshot first; expensive listener
  scans stay behind an explicit rescan action or another documented one-time policy

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

If the failure only appears in the full suite, rerun the smallest affected file first, then fix
the harness cause before broadening timeouts.

For browser performance cases, a proven shared-browser-process contamination issue should be solved
by isolating that exact case into its own Playwright invocation while keeping the assertion in the
default scripted gate. Do not weaken the assertion or convert it into a soak-only check just
because Chromium reuse is noisy.

When browser build freshness is under review, keep the owner split explicit:

- runner scripts may auto-prepare stale browser artifacts once before Playwright starts
- the standalone harness must still reject stale or missing browser artifacts as a backstop
- do not key freshness to whole-file `package.json` mtime when only a narrower build input, such
  as the shipped app version, is actually required

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
- a click on one file must fetch that file's diff directly instead of hydrating a whole-task patch
  just to scroll to the selected path
- profile subprocess fan-out before adding renderer-side caches or heuristics

### 10. Scoped Vitest runs should use the repo timeout wrapper

Detached or orphaned ad hoc Vitest runs are easy to miss, especially during iterative UI work.

### 11. Cleanup and projection rules belong at the owner seam

When a workflow or projection keeps temporary local state, review the full ownership boundary, not
just the inner happy path. Cleanup and reconciliation should happen where the owner can see the
whole operation, including late failures and mixed entity types.

### 12. Shared entrypoint policy must stay single-sourced

If multiple runners or entrypoints expose the same skip, freshness, auth, or readiness contract,
keep that rule in one canonical owner and make the wrappers compose it instead of reinterpreting
it locally.

- use `npm run test:node:file -- ...` or `npm run test:solid:file -- ...` for targeted runs
- avoid raw `npm exec vitest ...` when the repo wrapper can provide timeout and process-tree cleanup
- when Solid/jsdom files are stable alone but drift together, isolate them in the scoped runner
  rather than normalizing shared-worker timing flakiness as product behavior
- if a leaf-component test is flaky because it is proving state owned by a helper/runtime module,
  move the detailed state assertions to the owner seam and keep the leaf integration check minimal

### 11. Replacement restores must win before queued output drains

Reconnect recovery can queue a second restore while the first restore is still settling. If live
output is allowed to flush in the handoff window, the replacement restore can replay against
already-drained bytes and quietly duplicate or reorder output.

- when a reconnect restore is superseded, start the replacement restore before scheduling queued
  output flushes
- add a focused runtime test that proves queued output does not drain between the stale restore and
  the replacement restore

### 12. Process-driven harness readiness must survive chunking and failed startup

Server and harness tests often discover readiness from child-process stdout. That path is easy to
review too casually: logs arrive in chunks, and failed startup waits can otherwise leave a live
child process behind.

- accumulate stdout across chunks before matching readiness lines
- when startup readiness fails, stop the spawned process and clean temporary test state in the same
  failure path

### 13. Sibling surfaces with the same intent must share one backend path

The recent slow-diff bug was not a raw performance problem. It was an ownership drift problem:
sibling surfaces that looked equivalent were routing the same user intent through different backend
query paths.

- when two surfaces expose the same task-level intent, identify the one canonical backend/query
  path first and verify both surfaces use it
- do not let optional UI props silently choose between canonical task truth and ad hoc local fetches
- add at least one targeted test or architecture guard that proves the sibling surfaces stay aligned

### 14. Local open and focus should not imply whole-system work

### 15. Transitional lifecycle UI must have a live owner and exit path

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

### 16. Stress tests should fail on invariant leaks, not just missing copy

Manual smoke often finds bugs that look like “it still says restarting/restoring” or “the prompt
is back but typing does nothing”. Those are invariant failures across owners.

- browser stress helpers should capture enough owner state to explain which invariant leaked:
  supervision, controller ownership, transport/lifecycle banner, and terminal DOM state
- prefer reusable invariant assertions over one-off timeout waits
- when a browser scenario proves a cross-owner lifecycle contract, keep the lower-seam deterministic
  churn test too

Open and focus transitions are easy places for renderer convenience to drift into hidden expensive
backend work.

- opening a local surface should render from current canonical snapshot/projection state first
- if a whole-host or whole-project scan is still required, make it explicit in workflow policy and
  prove that it happens only when intended

### 15. Backend mirrors of persisted state must track the current codec shape

Registry-style backend mirrors are easy to leave on an old persisted field name while the canonical
codec evolves somewhere else. That silently drops metadata even though the runtime still has it.

- when a backend mirror parses persisted task or session state, verify it accepts the current codec
  field shape first and only keeps legacy field names as backward-compatible fallback
- when workflow-owned create/update paths already know task metadata that the backend mirror needs,
  pass it through the owning request/registry seam instead of hoping persistence catches up later

### 16. Remote triage surfaces should show backend-owned actionability, not renderer recency

Remote/mobile list rows are control surfaces. They should help the user decide which task to open
or take over next, not simply replay generic "recently active" status text.

- remote/mobile row badges should come from canonical pushed backend state like supervision,
  task-review, task-ports, and task-command ownership
- avoid recency timers or vague activity labels as primary row metrics when the backend already
  knows waiting, ready, blocked, conflict, or preview state
- transport validation should reject malformed or forward-incompatible remote payloads before they
  can crash presentation logic or silently widen UI state

### 17. Presence cues are not controller locks

Remote presence is valuable for triage, but it is still a softer hint than controller snapshots. If
one surface promotes presence fallback into a blocked/read-only state while another waits for
controller truth, the UI will disagree about whether the task is actually locked.

- blocked counts, takeover warnings, and read-only gating should come from task-command controller
  snapshots
- presence-only ownership can still be shown as a softer cue, but it needs a distinct label/tone
  so it cannot be confused with a confirmed lock
- add a focused test that presence-only state does not increment blocked counters or reuse the same
  warning label as a controller-confirmed owner

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

Transitional lifecycle UI must not outrun the owner that clears it. If a reconnect, restore, or
automatic pause transition depends on a later owner to finish the work, keep the earlier visible
state until that owner actually starts.

- reconnect banners should stay in `reconnecting` until authenticated control traffic confirms
  restore start
- when an automatic pause clears, reclassify from the saved tail instead of falling back to a
  generic busy/active state

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
