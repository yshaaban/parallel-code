# Review Rules

Use this document when reviewing non-trivial changes in Parallel Code, especially:

1. upstream ports and parity work
2. browser-mode transport, auth, reconnect, restore, or persistence changes
3. preview and exposed-port behavior
4. test harness changes that can affect suite-order stability

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) for ownership rules and [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for the upstream-port workflow. Use this file as the practical review checklist and lessons-learned record.
For the hands-on terminal/browser-lab workflow and the non-obvious contribution rules that are
easy to miss in code review, also read
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).

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
4. run the full gate after targeted green if the change touches runtime, preview, persistence, or shared test harnesses

For terminal/browser runtime work, `npm test` is not the full gate by itself. Include the relevant
browser-lab and runtime/stress seams as well.

Do not review a port only by comparing file shape to upstream. Review whether the behavior landed in the correct local owner.

## Browser Runtime Review Rules

When a change touches browser mode, explicitly verify:

- reconnect does not start restore before authenticated control traffic is confirmed
- restore and replay do not run on raw socket state alone
- persistence fast paths do not skip required side effects like project-path validation
- state that can update through both request/response IPC and sequenced control events carries a
  backend ordering signal; do not rely on renderer arrival order or local heuristics to decide
  which update wins
- no-op sync optimizations do not remount terminals or recreate task / agent state
- auth-expired, reconnect, and connected states still preserve clear ownership between transport and workflow layers

If any of those are unclear, add or update runtime tests before treating the change as review-ready.

## Preview And Port Review Rules

When a change touches preview or observed ports, explicitly verify:

- terminal-output parsing is treated as a hint, not canonical truth
- noisy shell fragments are sanitized without trimming legitimate URL syntax
- authenticated preview routing preserves nested paths and static assets
- preview UI density changes do not hide state transitions or error handling
- new exposure flows distinguish task-owned observed ports from dialog-local scan suggestions

For parser changes, add at least one regression for:

1. the broken real-world string
2. a nearby valid string that must stay intact

## Test Harness Review Rules

When a review uncovers suite-order flake, prefer fixing the harness cause instead of raising timeouts.

Check for:

- timer state inherited across tests
- background intervals not cleaned up in `finally`
- listener cleanup keyed only by channel name instead of listener identity
- tests waiting for weak intermediate signals instead of real completion signals
- async startup work from one test still mutating shared mocks in the next test

If the failure only appears in the full suite, rerun the smallest affected file first, then the full gate again after the harness fix.

## IPC And Persistence Review Rules

When a change touches renderer invoke typing, handler validation, or persisted-state parsing, explicitly verify:

- required request channels stay required in the shared request map instead of being widened to `undefined` for transport convenience
- optional request channels are explicit and mirrored by the handler-side allowlist or guard path
- malformed handler input is classified as `BadRequestError`, not a generic internal error
- repeated saved-state fragments are parsed through one shared parser or type source instead of local `JSON.parse(...) as ...` copies
- full-state and workspace-state persistence still serialize shared task and terminal records through the same helpers instead of drifting into parallel save builders
- task removal and incremental workspace reconciliation still clear task-scoped derived state through the same cleanup authority instead of maintaining separate delete clusters
- app, runtime, and presentation code do not import `store/core.ts` directly; use `store/state.ts`, `store/store.ts`, or a narrower authority module instead
- task-command controller consumers read through selector helpers instead of reaching into `store.taskCommandControllers` directly
- incoming task takeover consumers read through `task-command-takeovers` selectors instead of sorting `store.incomingTaskTakeoverRequests` inline
- closed-domain task review metadata stays centralized in `domain/task-convergence.ts` instead of reintroducing per-screen `Record<TaskReviewState, ...>` tables
- task close lifecycle changes keep using the discriminated `Task.closeState` model instead of reintroducing ad hoc `closingStatus` / `closingError` task fields
- immediate task-summary projections used by remote/mobile still derive branch/folder/agent metadata through the shared task registry owner, not ad hoc in transport handlers
- standalone/browser-lab build-freshness guards do not silently become prerequisites for node/backend integration suites; test harnesses must opt into any bypass explicitly
- node integration suites that spawn `dist-server` still validate compiled runtime behavior, so the scripted gate must build `dist-server` first instead of assuming compiled output is current
- restore paths only tolerate partial persisted fragments where the canonical parser says they should
- shared transport/domain payload types live in DOM-neutral modules, not in browser runtime files
  that touch `window`, `document`, or Solid runtime helpers

If any of those drift, add or update direct node tests before treating the change as review-ready.

## Recent Lessons Worth Reusing

### 1. Reconnect restore must wait for authenticated control traffic

A raw websocket `connected` event is not enough to treat browser restore as safe. On deployed servers, that can start replay too early and create `check_path_exists`, `list_running_agent_ids`, and `spawn_agent` churn.

Review rule:

- browser restore should start from confirmed authenticated control traffic, not from transport open alone

### 2. No-op persistence fast paths still need reconciliation side effects

Skipping an identical persisted JSON payload is fine, but not if it also skips follow-up checks that keep derived state fresh.

Review rule:

- if a sync path becomes a no-op for durable state, re-check whether validation, path refresh, or diagnostics still need to run

### 3. Port sanitizers must preserve real URLs while dropping shell noise

Shell fragments like `2>&1)` or pasted curl flags should not survive into observed-port suggestions. But valid path characters like `&` inside a real URL should not be stripped either.

Review rule:

- every parser hardening change needs both a broken-string regression and a nearby valid-string preservation test

### 4. Listener cleanup must be identity-aware in shared test harnesses

If a test mock removes listeners by event name only, stale async cleanup from one test can delete the next test's listener and create non-reproducible timeouts.

Review rule:

- test harness cleanup for listeners should remove only the exact listener that was registered

### 5. Wait for completion signals, not incidental calls

`loadState()` being called is often too early to prove startup completed. Prefer waiting for the actual post-startup signal the test claims to assert.

Review rule:

- choose the readiness assertion that matches the behavior under review, not the earliest call in the chain
- for browser terminals, verify that the UI cannot report `ready` before restore, resume, and
  post-restore input draining are actually complete

### 6. Required IPC payloads should stay exact

It is easy to loosen request typing just to make a transport helper convenient. That hides real request-shape drift and turns malformed calls into late runtime failures.

Review rule:

- keep required request payloads required in the shared invoke map, make optional channels explicit, and reject missing required payloads as bad requests at the handler boundary

### 7. Persisted-state parsing should be shared once

When multiple restore or watcher paths parse the same saved-state fragment independently, they drift quietly and recover different subsets of state.

Review rule:

- if more than one path needs the same persisted fragment, parse it once through a shared parser and reuse that canonical shape everywhere

### 8. Cross-plane live state needs backend ordering

When the same live state can update through an invoke/fetch response and through sequenced control-plane events, arrival order in the renderer is not trustworthy.

Review rule:

- version or sequence the backend snapshots themselves and ignore stale renderer updates at the store/projection boundary

### 9. Module-local runtime state needs an explicit test reset seam

Workflow and transport modules often keep timers, retry queues, retained handles, or subscriptions in
module scope. Those are easy to review incorrectly because isolated tests may pass while the full
suite reuses stale module state.

Review rule:

- if a module keeps runtime state outside the store/backend, give tests an explicit typed reset seam
  or isolate the module import/reset path; do not rely on suite order to clear it implicitly

### 10. Terminal recovery must be structured catch-up, not live replay disguised as restore

Terminal switching and reconnect bugs often come from treating history replay as ordinary live
output or from using destructive reset as the default fix for lost continuity. Recovery bugs are
easy to hide because the final buffer can look correct even when the runtime briefly reset the
viewport, replayed historical bytes as ordinary `Data`, or kept stale local content during a
shorter authoritative snapshot.

Review rule:

- keep terminal recovery backend-owned and explicit: `noop`, `delta`, or snapshot fallback
- channel recovery signals should request structured recovery, not inject historical output through
  the normal live stream
- `noop`, `delta`, and `snapshot` recovery paths should stay explicit and testable
- do not inject historical scrollback through the live `Data` stream on rebind
- prefer cursor-based recovery over local tail heuristics whenever the retained backend cursor is
  still valid
- only the snapshot path should take the destructive reset lane; delta/no-op recovery should not
  show blocking restore UI or repaint the whole terminal
- browser-lab coverage for non-destructive recovery should record terminal status transitions and
  prove that delta/no-op recovery never entered the blocking `restoring` state
- do not accept a renderer-side fix that only hides flicker while still replaying the same history
- add at least one browser regression that types during recovery, not only after the terminal is
  visibly ready

### 11. Browser-lab validation must run against fresh build artifacts

Playwright browser-lab coverage runs against the standalone `dist`, `dist-remote`, and
`dist-server` artifacts. If those artifacts are stale, a test run can appear green while it is
actually exercising an older build.

Review rule:

- fail fast when standalone browser-lab artifacts are missing or older than the relevant source
  trees
- do not treat browser-lab results as current-source validation unless the build freshness check
  passes

### 12. Remote/mobile control must apply backend controller snapshots immediately

Remote/mobile terminal control now updates through both HTTP IPC lease calls and websocket control
messages. The HTTP result is already backend truth and carries the controller version.

Review rule:

- remote/mobile control paths must apply acquire, renew, and release controller snapshots locally
  instead of collapsing them to booleans and waiting for a later websocket echo
- guard remote controller snapshots by backend version before updating projection state; do not let
  older bootstrap or websocket events overwrite newer control truth
- presence-only ownership cues are UI hints only; they must never block writes or decide takeover
  policy

### 13. Remote/mobile transport loss must invalidate local control lifecycle state

The remote runtime needs the same disconnect discipline as desktop. When transport drops, retained
leases, pending takeovers, and incoming takeover prompts must be invalidated immediately instead of
waiting for eventual reconnect cleanup.

Review rule:

- remote/mobile task-command state must subscribe to transport availability and clear retained
  lease timers, pending takeover waits, and incoming takeover prompts on disconnect, reconnect, or
  auth loss
- remote/mobile presence heartbeats must restart after a hide/show cycle; add explicit visible-again
  coverage when touching presence lifecycle code

### 14. Prefer scripted standalone repro paths over hand-managed browser servers

Browser-terminal debugging is easy to misread if a local standalone server is already running from
an older build or older checkout.

Review rule:

- prefer scripted standalone repro and browser-lab entrypoints over manually reusing a long-lived local server
- when validating terminal/browser behavior locally, prefer the repo scripts that build and launch

### 15. Architecture guards must target the real owner, not a thin facade

Once a module becomes a pass-through facade, source-level architecture tests can silently stop
checking the real behavior owner if they keep reading the old file.

Review rule:

- when splitting a module into facade + owner files, move source-level architecture assertions to
  the owner file that still contains the policy or raw selector usage

### 16. `ipc-events` test doubles must preserve the underlying IPC channel identity

The `src/lib/ipc-events.ts` helpers are typed wrappers around concrete IPC event channels. If a
test mocks those helpers as opaque callbacks instead of mapping them back to the underlying channel
constants, startup and buffering tests can stop observing the real listener keys.

Review rule:

- when mocking `ipc-events` helpers in runtime/startup tests, register them against the real IPC
  channel constant so the test still observes production listener identity
  a fresh standalone server for the scenario under test

### 14. Remote mobile changes need a browser-level naming and submit-flow proof

Remote mobile regressions can look fine in component tests while still failing the first-run session
naming flow or leaving the command input focused after submit, which keeps the software keyboard open
and hides new output on real phones.

Review rule:

- for remote mobile list/detail changes, add or update browser-lab coverage for first-run session naming, desktop presence visibility, and submit releasing focus after send

### 15. Treat broken `/remote` routes as a product plus deploy-safety problem

A deployed `/remote` failure can come from stale `dist-remote` artifacts even when the current
source tree is correct.

Review rule:

- compare the served remote asset hash against the current local `dist-remote` build before you
  assume the runtime code is broken
- if you are bypassing the npm wrapper scripts, run `npm run prepare:browser-artifacts` before raw
  browser-lab or profiler commands
- run `npm run smoke:remote -- --server-url <url> --auth-token <token>` against the deployed
  server; do not rely on hand-driven mobile checks
- keep the browser-server build-freshness guard in place so stale `dist-remote` does not ship
  silently from a source checkout

### 16. Keep task-command focus semantics shared across desktop and remote

Ownership cues and typing-lease retention drifted because desktop presence, remote/mobile
presence, and lease cleanup each maintained their own notion of which surfaces count as "typing".

Review rule:

- keep focused-surface to task-command-action mapping in one shared helper instead of duplicating
  the switch across desktop presence, remote presence, and lease cleanup code
- treat the main desktop terminal panel (`terminal`) as a typing surface alongside `ai-terminal`,
  `remote-terminal`, and `shell:*`

### 17. Reset streamed remote preview decoders on transport-boundary loss

Remote/mobile preview decoding uses streaming `TextDecoder` state. That state is safe only while
message continuity is intact.

Review rule:

- if remote websocket continuity is lost, reset per-agent streaming decoders before processing new
  preview chunks
- keep scrollback snapshot decoding independent from the streaming decoder path

### 18. Controller snapshot ordering must survive controller clears

Task-command controller projections can receive both "controller cleared" and "controller
acquired" snapshots for the same task across HTTP and websocket paths. If the renderer drops the
per-task version truth when a controller clears, an older snapshot can be re-applied later.

Review rule:

- keep controller version truth separate from the live controller record so a newer clear snapshot
  still blocks older later arrivals
- only drop per-task controller version truth when the task itself is removed or the whole
  controller projection resets; an ordinary cleared-controller snapshot must keep its ordering
  protection
- add an explicit stale-after-clear regression anywhere controller projection ordering changes

### 19. Lease and controller mocks must carry backend snapshot versions

Task-command lease responses are authoritative controller snapshots, not just booleans. Tests that
mock acquire, renew, or release without a controller `version` can silently stop exercising the
real projection path.

Review rule:

- when mocking task-command lease IPC, return full versioned controller snapshots
- prefer typed shared response shapes over local partial mock objects for acquire / renew / release

### 20. Remote bootstrap must be explicit about handled versus ignored categories

Remote/mobile consumes only a subset of the shared bootstrap categories. Silently dropping unknown
categories makes drift hard to detect during ports and refactors.

Review rule:

- keep remote bootstrap handling explicit: either apply the category, intentionally ignore it, or
  fail loudly through exhaustiveness helpers
- do not hide category drift behind an open-ended default branch

### 21. Full-state persistence hydration should reuse the canonical workspace parsers

The easiest way for persistence drift to reappear is to let full-state load and workspace-state
load parse tasks and projects through different local code paths.

Review rule:

- keep full-state and workspace-state hydration on the same shared project/task parsers and
  hydrated-task builders
- if a persistence refactor adds a second parser path, treat it as a review finding, not a style
  preference

### 22. Remote live-event paths must classify handled versus ignored messages explicitly

Remote/mobile now has the same expectation for live websocket messages and live IPC events that it
already has for bootstrap snapshots: every currently relevant category must be explicitly
classified.

Review rule:

- do not use `default: break` on the remote websocket `ServerMessage` union
- classify each remote message or event channel as either handled now or intentionally ignored now
- keep the remote live IPC-event channel set in one shared source of truth, not duplicated local
  unions on the server and remote sides
- keep the remote live websocket path and the remote live IPC-event path aligned with the current
  remote UI scope so future feature work cannot add server messages silently

### 23. Review-session surfaces must share the comment workflow

The review regressions here came from keeping one review surface on the shared
`ReviewSession`/sidebar path while another silently drifted away. We hit this first with embedded
diff review, then again with plan review after the diff-surface reconciliation. The failure mode is
the same: comments still exist in state, but one surface loses copy/export or prompt-with-comments
actions.

Review rule:

- keep every `ReviewSession`-based surface on the same shared review-session/sidebar/export flow
- prefer the shared `createReviewSurfaceSession(...)` bootstrap so review-session creation,
  sidebar wiring, and comment-copy behavior do not drift surface by surface
- if a surface uses `createTaskReviewSession`, it should also preserve the shared comment copy and
  prompt actions instead of becoming submit-only
- do not treat one diff renderer as the owner of review-comment behavior
- if `ReviewPanel` is split into feature-local leaves, keep session creation, file/diff fetching,
  and task-AI workflow imports in `ReviewPanel.tsx`; extracted review leaves should receive
  pre-derived props and callbacks instead of importing those owners directly
- if split and unified diff modes coexist, preserve the comment/export workflow instead of
  dropping it during view reconciliation

### 24. Queued takeover state must stay visible as a queue

Both desktop and remote/mobile can receive multiple pending takeover requests. The state owners
already keep the full sorted queue, so truncating the UI to the first request creates a false view
of control state and makes later requests effectively invisible.

Review rule:

- if takeover state is stored as a queue, the owner-side UI must render the queue or an explicit
  summarized queue surface
- do not collapse queued takeover state to the first item in a leaf component unless the workflow
  owner explicitly defines it as single-request

### 25. Leaf chrome should reopen App-owned dialogs through the action registry

Browser session naming needs both a first-run required prompt and a steady-state edit entry point.
The dialog owner stays in `App.tsx`; leaf chrome such as the sidebar footer should only trigger the
existing dialog through the shared action registry.

Review rule:

- keep task- or app-level dialog state in the workflow/app owner
- if a footer, header, or toolbar needs to reopen that dialog, wire it through the existing action
  registry instead of creating a second dialog owner in the leaf

### 26. Task removal and workspace reconciliation must share cleanup authority

Task-scoped derived state is easy to clear incompletely because task close/remove workflows and
incremental workspace reconciliation both need to remove the same slices.

Review rule:

- keep task-scoped cleanup for agents, terminals, convergence, review state, controller state, and
  panel-side state behind one shared cleanup authority
- if a task-scoped owner also keeps module-local runtime caches keyed by task or worktree, clear
  that runtime state through the same cleanup path; deleting only the store slice is incomplete
- if a new task-scoped slice is added, update the shared cleanup helper instead of adding another
  inline delete cluster in workflow or persistence code

### 27. Keep primitive store access behind the sanctioned store boundary

`src/store/core.ts` is the internal primitive store implementation. App, runtime, and presentation
code should not couple to it directly.

Review rule:

- treat `src/store/state.ts` as the sanctioned primitive facade when an owner module truly needs
  direct `store` / `setStore` access
- otherwise use `src/store/store.ts` or the narrower store authority for the concept under review
- add or keep architecture coverage that fails if non-store production code imports `store/core`

### 28. Raw controller-map reads are a review finding

Task-command ownership already has a shared projection layer and named selectors. Reading the raw
controller map directly recreates local fallback policy and version assumptions at each call site.

Review rule:

- treat direct reads of `store.taskCommandControllers` outside the controller authority module as a
  review finding
- if a consumer needs controller enumeration, add a named selector in the controller authority
  instead of iterating the raw map inline

### 29. Task close lifecycle should stay discriminated

The task close lifecycle now uses `Task.closeState` so invalid combinations are not representable.

Review rule:

- keep task close transitions on the discriminated `closeState` model
- do not reintroduce loose task-level `closingStatus` or `closingError` fields just because one UI
  site wants a shortcut
- if a new close-state variant is added, update the shared `task-closing` predicates and the close
  state writer helpers in the same change

### 30. Focused-panel reads should stay behind focus selectors

`focusedPanel` now has a canonical normalization and selector owner in `src/store/focus.ts`.
Reading the raw store map directly recreates defaulting and panel-id interpretation at each call
site.

Review rule:

- treat direct reads of `store.focusedPanel` outside `src/store/focus.ts` and the explicitly
  audited persistence/session code as a review finding
- if a consumer needs another focused-panel answer, add a named selector in the focus owner
  instead of reinterpreting the raw map locally
- terminal/session code may register late focus callbacks, but it must not decide startup focus on
  its own; pending panel focus replay belongs in the focus owner so background terminals cannot
  steal DOM focus while they finish loading

### 31. Keep split facades thin after decomposing a hub

Once a monolith is split into a stable facade plus focused owners, new logic should land in the
focused owners instead of drifting back into the facade file.

Review rule:

- `src/app/task-workflows.ts` should stay a thin facade over the lifecycle, prompt, and shell
  workflow owners
- `src/store/taskStatus.ts` should stay a thin facade over output-activity, ready-callback, and
  question-state owners
- `src/store/persistence.ts` should stay a thin facade over save, load/reconcile, codec, and
  sync-session owners
- full-state reset paths must clear module-local runtime owners before rebuilding the store; store
  slice replacement alone does not reset split task-status or git-status runtime state

## What To Update With The Code

If the change is non-trivial, update the docs in the same branch:

- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for upstream parity status, port classification, or new lessons from an upstream sync
- [TESTING.md](./TESTING.md) when the change teaches a reusable testing rule
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) when the change teaches a reusable terminal/browser-lab workflow rule or non-obvious contributor practice
- [AGENTS.md](../AGENTS.md) or [CLAUDE.md](../CLAUDE.md) when contributor or agent workflow rules changed

The goal is to leave behind a repeatable review rule, not just a one-off fix.
