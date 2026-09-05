# Upstream Divergence Playbook

This playbook records how Parallel Code has diverged from upstream and how to port upstream
changes without reintroducing architecture churn.

Use it when:

1. reviewing upstream commits
2. deciding whether to cherry-pick, manually port, or reimplement a change
3. mapping an upstream file change onto this repo's newer architecture
4. explaining why a direct cherry-pick is the wrong tool even when the behavior is still wanted

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first for the ownership rules.
Use this document for the practical porting workflow. Use [REVIEW-RULES.md](./REVIEW-RULES.md)
for recurring review traps and validation rules from prior ports.

## Why This Fork Diverged

This fork diverged to support a stricter architecture and runtime model:

- backend-owned canonical state for more domains
- stronger browser/server parity
- more explicit browser multi-client presence and takeover coordination
- more explicit runtime controllers and workflows
- stricter startup, restore, replay, and persistence semantics
- better reliability, scenario coverage, and test hardening
- clearer boundaries between transport, workflow, store, and UI

Some upstream changes still map cleanly, but many now need to be ported by intent instead of file
shape.

## The Core Divergence

In upstream, useful behavior sometimes still lands in large UI components, broad IPC files, or older startup wiring.

In this repo, the direction is:

- backend owns external truth
- handlers validate and route
- workflow/app modules coordinate multi-step behavior
- store projects canonical state into UI-facing models
- components present and manage local ephemeral UI state

The same feature can live in different files here even when the user-facing behavior is the same.

## Important Practical Difference

This repo currently uses:

- `origin` as this fork's writable repository
- `original` or `johannesjo` as read-only upstream aliases when they are configured locally

Review upstream sync work against the local architecture first, then push to the fork remote rather
than mirroring upstream history directly. Verify local names with `git remote -v` before fetching or
pushing; older checkouts may still use `fork` for the writable remote.

## Current Upstream Sync Status

As of the `2026-08-03` frozen review, this repo has:

- reviewed upstream head: `054060bad10cc144d054661fd1702b54523c92b0`
- last reviewed upstream head before that intake: `09c2507dc21b909d473e15ccd207ebbdaaa5a7a7`
- historical divergence baseline used by the earlier ledgers: `b250446`
- latest reviewed upstream delta: `09c2507dc21b..054060bad10c` (`145` commits)

Important details:

- parity after `b250446` is selective, not contiguous
- this fork intentionally ports some upstream commits by behavior while deferring or reimplementing others
- do not assume "we are synced through commit X" unless the commits in that range were either
  cherry-picked directly or explicitly reimplemented here
- the `2026-03-21` review extended coverage through the later refactor/UI tail on `origin/main`;
  only the small prompt-send and channel-lifecycle subset of `2430b97` was worth porting
- the `2026-04-01` re-review confirmed that `origin/main` advanced from `4792390` to `91f00f4`
- the `2026-04-16` full-range consolidation re-reviewed the entire upstream-only span
  `b250446..91f00f4` against current `main`
- the `2026-04-17` catch-up pass now covers the new upstream-only span `91f00f4..a0f5280`
- the detailed per-commit ledger for that new delta lives in
  [UPSTREAM-CATCHUP-2026-04-17.md](./UPSTREAM-CATCHUP-2026-04-17.md)
- the `2026-05-08` catch-up intake covers the new upstream-only span `a0f5280..af685eb`
- the detailed per-commit ledger for that new delta lives in
  [UPSTREAM-CATCHUP-2026-05-08.md](./UPSTREAM-CATCHUP-2026-05-08.md)
- the `2026-05-08` follow-up catch-up intake covers the new upstream-only span
  `af685eb..7aaf640`
- the detailed per-commit ledger for that follow-up delta also lives in
  [UPSTREAM-CATCHUP-2026-05-08.md](./UPSTREAM-CATCHUP-2026-05-08.md)
- the `2026-05-24` catch-up intake covers the new upstream-only span
  `7aaf640..6097655`
- the detailed per-commit ledger for that delta lives in
  [UPSTREAM-CATCHUP-2026-05-24.md](./UPSTREAM-CATCHUP-2026-05-24.md)
- the `2026-06-01` catch-up intake covers the new upstream-only span
  `6097655..09c2507dc21b`
- the implementation plan and working decision ledger for that delta was kept under local `tmp/`
  during the catch-up pass; this document owns the durable summary
- the `2026-08-03` frozen review covers `09c2507dc21b..054060bad10c`; its commit ledger accounts
  for all `145` commits exactly once, while the selected behavior and current status are recorded
  below
- the earlier `2026-04-16` work remains the historical action-plan record for the prior frozen
  range; it is no longer the full upstream picture
- the `2026-04-17` catch-up pass is closed except for redesign-only Docker isolation:
  - the direct-port git / changed-files / terminal / settings subset is landed or explicitly
    closed without direct port
  - the browser-first task-steps redesign is landed locally
  - the remaining intentionally open parity question is redesign-only Docker isolation if product
    direction changes

The detailed per-commit ledger for the `2026-03-28` pass lives in
[UPSTREAM-CATCHUP-2026-03-28.md](./UPSTREAM-CATCHUP-2026-03-28.md).
The detailed per-commit ledger for the `2026-04-01` pass lives in
[UPSTREAM-CATCHUP-2026-04-01.md](./UPSTREAM-CATCHUP-2026-04-01.md).
The detailed per-commit ledger for the `2026-04-17` pass lives in
[UPSTREAM-CATCHUP-2026-04-17.md](./UPSTREAM-CATCHUP-2026-04-17.md).
The detailed per-commit ledger for the `2026-05-08` pass lives in
[UPSTREAM-CATCHUP-2026-05-08.md](./UPSTREAM-CATCHUP-2026-05-08.md).
The detailed per-commit ledger for the `2026-05-24` pass lives in
[UPSTREAM-CATCHUP-2026-05-24.md](./UPSTREAM-CATCHUP-2026-05-24.md).
The consolidated per-commit action ledger for the full upstream-only range now lives in
[UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md](./UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md).
The execution plan for bringing those changes over lives in
[UPSTREAM-PORT-PLAN-2026-04-16.md](./UPSTREAM-PORT-PLAN-2026-04-16.md).

### Current Open Queue

The detailed historical port record lives in:

- [UPSTREAM-CATCHUP-2026-03-19.md](./UPSTREAM-CATCHUP-2026-03-19.md)
- [UPSTREAM-CATCHUP-2026-03-28.md](./UPSTREAM-CATCHUP-2026-03-28.md)
- [UPSTREAM-CATCHUP-2026-04-01.md](./UPSTREAM-CATCHUP-2026-04-01.md)
- [UPSTREAM-CATCHUP-2026-04-17.md](./UPSTREAM-CATCHUP-2026-04-17.md)
- [UPSTREAM-CATCHUP-2026-05-08.md](./UPSTREAM-CATCHUP-2026-05-08.md)
- [UPSTREAM-CATCHUP-2026-05-24.md](./UPSTREAM-CATCHUP-2026-05-24.md)
- [UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md](./UPSTREAM-CONSOLIDATED-ACTION-PLAN-2026-04-16.md)

This file tracks the narrower question: what is still open right now?

The `2026-04-16` review closed the prior `b250446..91f00f4` bring-with-modifications queue. The
`2026-04-17` catch-up pass covers `91f00f4..a0f5280`, and its planned implementation work is
closed. The `2026-05-08` catch-up pass covers `a0f5280..7aaf640`, tracked in
[UPSTREAM-CATCHUP-2026-05-08.md](./UPSTREAM-CATCHUP-2026-05-08.md), and is also closed as
selective behavior catch-up work.

The latest frozen catch-up review covers `09c2507dc21b..054060bad10c`. The local
`upstream-review/main` reference used on `2026-08-03` was `054060bad10cc144d054661fd1702b54523c92b0`,
and the ledger accounts for all `145` commits in that range, so there were `0` unreviewed commits
inside the frozen range. This does not claim that the live upstream repository has not advanced
after the review. The local branch still reports graph divergence from upstream; that is expected
because this fork ports upstream behavior into local architecture owners rather than merging
upstream history directly.

The selected outcomes from that range are recorded below with their current activation status.
Commits classified as deferred remain deliberate future product/design choices, not an unfinished
implementation queue from this catch-up.

The bring/remap queue from `6097655..09c2507dc21b` is being landed locally without merging upstream
history. The local implementation ports the behavior that fits this fork's browser-first ownership:

- backend branch-ref prefix conflict checks before managed worktree creation, with New Task dialog
  advisory validation when branch data is available
- explicit PTY replacement intent for restart/switch flows while keeping ordinary remount,
  reconnect, and multi-client attaches non-destructive
- merged-task progress semantics, leaving plain close/remove flows out of the daily progress count
- privacy disclosure for browser/server mode, authenticated remote clients, query tokens, preview
  proxying, project discovery, terminal data, custom commands, and runner/container execution
- built-in Antigravity CLI launch/resume metadata without importing upstream's coordinator/MCP
  restore path
- sidebar focus/status tooltip polish, merge target copy, New Task text-selection restraint, and
  clearer arena merge copy through local presentation owners
- dependency refresh through the local lockfile and npm override workflow, including patched
  `tmp`, `dompurify`, `electron`, `vite`, MCP transport dependencies, and related transitive
  security updates

Coordinator prompt-delivery, task-command lease ownership, hidden subtask inspection, explicit
subtask cleanup, and task self-landing have now been ported by behavior through the local
browser-server coordinator owner. Upstream's MCP runtime and Antigravity MCP restore path are still
not imported because they depend on a different desktop-local coordinator architecture. Any future
parity work in that area must continue to flow through the backend-owned, replayable, multi-client
coordinator design in this fork.

The bring/remap queue from `7aaf640..6097655` landed locally without merging upstream history. The
local result is recorded by behavior and by local implementation commits:

- diff and changed-file correctness: blank-area diff double-click handling, selectable diff text,
  changed-file chrome selection cleanup, and merge-base-to-working-tree counts
- prompt and terminal interaction reliability: multiline bracketed-paste-aware prompt auto-send,
  line-count-scaled submit delay, terminal-family focus navigation, and task-reorder keybindings
  moved off native word-selection chords
- window/session safety: three-choice running-session close decision and renderer close-handling
  acknowledgement that clears the backend force-close fallback
- backend/IPC hardening: strict branch validation, atomic write temp-file cleanup, and defensive
  agent argument copying
- sidebar/panel state: collapsed-project focus cleanup, hidden-project keyboard navigation, finite
  persisted-size guards, double-click reset, and responsive request-size caps
- dependency/security hygiene: local lock graph now resolves `ws@8.21.0`, `mermaid@11.15.0`, and
  transitive `qs@6.15.2`
- status/attention verification: shell activity, ready/review attention, busy precedence,
  git-status freshness/error handling, and mobile QR stale-result/placeholder behavior

The follow-up upstream-scope pass after the initial `2026-05-24` catch-up implemented the subset of
the previously deferred queue that fit the local architecture, again without merging upstream
history:

- branch selection now has a backend branch-list contract and New Task dialog selection/retry
  behavior.
- non-git projects are explicit project/task mode, not relaxed git assumptions; git-only review,
  merge, push, branch, and status affordances are unavailable from that mode.
- task-container runner profiles are backend inspect truth. Compose remains the supported
  task-container profile; Docker runner profiles are explicit `unsupported_runner_profile` until a
  separate backend runner execution policy exists.
- theme contrast, Monaco, and terminal background projections now have a source-level guard.
- update status has typed IPC and settings presentation, with browser/not-configured unsupported
  states instead of accidental upstream release checks.
- selected-agent projection is now persisted and applied across task navigation, prompt/diff/notes
  targeting, browser session restore, cold bootstrap, collapse/restore, and AI terminal rendering.
- coordinator mode now has a local browser-server backend owner for replayable runs, hidden
  subtasks, prompt delivery, task-command lease ownership, subtask inspection, explicit subtask
  cleanup, and self-landing. Upstream MCP shape is still not imported; Electron-only and
  Docker-runner coordinator paths remain unsupported until they have a separate gateway and
  credential policy.

Remaining design-only work is limited to arbitrary/custom theme editing beyond guarded built-in
tokens and deeper coordinator/MCP parity beyond the browser-server coordinator owner. Those pieces
still require separate product decisions and browser/mobile proof before implementation. Real Docker
agent runner execution and side-by-side multi-agent terminal layout now exist locally as
browser-first opt-in implementations with backend-owned runner identity and dedicated validation
lanes. The local multi-agent terminal surface includes explicit add-agent, select-agent, and
close-agent controls rather than direct upstream component shape. Docker sandbox and Docker-backed
Hydra adapter execution remain intentionally unsupported.

Recently landed locally:

<a id="remote-mobile-task-notes"></a>

- `2026-08-03` remote/mobile task notes:
  - upstream `26c7ae67`
  - status: `read/editor path active; writer complete and default-dark pending exact per-surface proof promotion`
  - reason: the useful Notes tab and explicit remote Save behavior share one backend
    content-CAS service with the typed desktop editor, D13 task-incarnation/removal admission, and
    canonical one-record host storage. The direct component/store bridge was rejected because it
    would preserve a second writer and allow stale broad saves to erase targeted notes. Both remote
    hosts instead use scoped principal/grant command registration, content-free invalidation, and
    authoritative reconnect refetch; the terminal remains mounted across the Notes switch. Fresh
    Issue/Update admission stays unavailable in production until an external clean-tree run proves
    and independently re-verifies the exact desktop or remote artifact identity. Terminal replay and
    already-admitted recovery remain enabled under rollback so durable work is not stranded.
  - proof: task-notes domain/service/handler/controller suites, both websocket/event compositions,
    the shared direct Notes HTTP adapter/client contract with standalone and Electron-hosted HTTPS
    parity, the exact Electron-hosted remote persistence/drain integration,
    `tests/browser/remote-task-notes.spec.ts`, `tests/browser/task-notes-performance.spec.ts`, the
    lazy-route bundle budget (9 KiB gzip mandatory Notes first-open closure plus a separate 3 KiB
    incremental on-demand recovery closure), entitlement architecture tests, and the deterministic
    external proof manifest cover the implemented path. No current dirty-tree result authorizes a
    production train.

<a id="reliable-initial-prompt-delivery"></a>

- `2026-08-03` reliable initial-prompt delivery:
  - status: `reimplemented locally and active`
  - reason: one durable backend owner now binds the saved draft, target agent generation, automatic
    readiness write, manual-send ambiguity, and removal cleanup. Managed creation queues the exact
    delivery identity; renderer controls consume correlated projections and remain a lazy UI slice.
    The generic removal cutover disables legacy prompt writers before the public capability appears.
  - proof: domain/journal/workflow/activation suites, the production facade tests,
    `tests/browser/initial-prompt-delivery.spec.ts`, its performance companion, and
    `tests/harness/initial-prompt-delivery-bundle-budget.test.ts` cover the active path.

<a id="accessibility-focus-and-reduced-motion"></a>

- `2026-08-03` app-wide keyboard focus and reduced motion:
  - `ff3de963`
  - `bf220cac`
  - `48df4d60`
  - `494ebdc2`
  - `0bc58068`
  - status: `reimplemented locally and active`
  - reason: the local port uses one zero-specificity main focus contract plus explicit remote/Arena
    boundaries, exact xterm/Monaco wrapper ownership, and system-color fallbacks. Reduced motion is
    an explicit final named-animation policy that preserves functional spinners and static status/
    terminal cues; task/sidebar appearance is local one-shot state with no persistence, listener,
    timer, transport, or backend ownership.
  - proof: `src/focus-visible-styles.test.ts`, `src/reduced-motion-styles.test.ts`, focused component
    suites, and `tests/browser/accessibility-preferences.spec.ts` cover the main, remote, and Arena
    boundaries.

<a id="git-action-capability-feedback"></a>

- `2026-08-03` consistent Git action capability feedback:
  - `bb0689b2`
  - status: `reimplemented locally and active`
  - reason: the upstream silent-shortcut fix is preserved without moving Git policy into the focus
    store. One app-layer, reason-bearing decision now drives merge/push visibility, shortcut and
    title intent, dialog churn revalidation, and final workflow admission; denied intent produces
    one accessible warning while backend Git checks and task-command leases remain authoritative.
  - proof: `src/app/task-git-action-capability.test.ts`, `src/app/task-workflows.control.test.ts`,
    `src/components/TaskTitleBar.test.tsx`, and the denial journey in
    `tests/browser/accessibility-preferences.spec.ts` exercise the shared decision at every entry.

<a id="question-state-drafting-and-focus"></a>

- `2026-08-03` question-state drafting and focus stability:
  - `a2fa1ef1`
  - `ba3d4fc9`
  - status: `reimplemented locally and active`
  - reason: the local port keeps backend supervision canonical, adds a generation-bound renderer
    safety blocker, and routes every editor affordance through one pure policy. Ordinary prompt
    bytes now pass a backend generation/version/question/lease/closing admission gate and a
    single-attempt semantic transport, so question drafting no longer steals focus or loses edits
    without making renderer state authoritative or turning ordinary sends into ready-only sends.
  - proof: the policy, admission, activity, and cross-runtime lifecycle owners have focused tests,
    including `src/runtime/agent-status-sync.test.ts`; the real interaction and latency lanes live in
    `tests/browser/prompt-question-drafting.spec.ts` and its performance companion.

<a id="agent-resume-fallback"></a>

- `2026-08-03` one-shot Claude resume-history recovery:
  - `60d76cbd`
  - status: `reimplemented locally and active`
  - reason: the narrow missing-conversation behavior is reimplemented through an explicit trusted
    built-in capability, bounded exact classifier, deterministic source-generation operation, and
    one durable backend journal/workflow rather than an exit callback that mutates renderer state.
    Compact initial/fallback identity survives rich-response eviction; drain/finalizer hooks retain
    evidence until canonical task absence. The production composition now activates the exact
    removal epoch, disables legacy generation/spawn writers, routes renderer manual actions through
    the managed workflow, and owns one backend exit subscription with a short system lease. Fallback
    trust includes the complete built-in launch tuple, not a same-ID persisted definition. Backend
    restart also stays owner-controlled: only an exact, durably completed clean-shutdown snapshot
    creates a one-shot next-generation restore permit; abrupt loss and ambiguous consumed permits
    fail closed. Canonical pre-journal tasks receive one explicit upgrade admission rather than
    reopening the removed renderer-config spawn path.
  - proof: classifier, journal, workflow, activation, retention, lifecycle, facade, status-sync, and
    lazy manual-action component suites plus `tests/browser/agent-resume-fallback.spec.ts` cover the
    active cross-runtime path. The shared reliability bundle gate counts the action's complete static
    closure and rejects eager preload or main-entry regression.

<a id="new-task-draft-preservation"></a>

- `2026-08-03` New Task draft preservation:
  - `894ce115`
  - `175654d7`
  - `a5dcead6`
  - `0a9f9d45`
  - status: `manual behavior port active in production`
  - reason: the local dialog now captures its post-prefill prompt/name baseline once per open
    generation and owns one guarded Cancel/overlay/Escape policy with nested-dialog focus recovery.
    The global shortcut owner no longer bypasses that policy, and no draft state enters stores,
    persistence, transport, or the unrelated upstream form structure.
  - proof: `src/components/new-task-dialog/new-task-draft.test.ts`,
    `src/components/NewTaskDialog.test.tsx`, and `tests/browser/new-task-dialog.spec.ts` cover every
    close route, clean prefills, focus restoration, and successful-submit bypass.

<a id="new-task-defaults"></a>

- `2026-08-03` persistent New Task defaults:
  - `120a5147`
  - documentation correction `0cf878c9`
  - status: `reimplemented locally and active`
  - reason: the upstream behavior now uses the grouped renderer-local preference owner, persists
    through Electron full state or browser client session without entering shared workspace state,
    and is sampled once per dialog open behind submit-time agent capability checks. Upstream's
    coordinator propagation default remains deliberately omitted because this fork has no matching
    user-facing policy.
  - proof: domain, local-shell, browser-session, persistence, Settings, and New Task dialog tests
    cover detached sampling, malformed-state fallback, storage boundaries, and submit-time capability
    gating.

<a id="merged-metrics-consistency"></a>

- `2026-08-03` atomic merged-progress consistency foundation:
  - `bb362aa1`
  - status: `reimplemented locally and active`
  - reason: the local port now uses one versioned progress snapshot and one server-issued merge
    operation through typed Issue/Start/Status channels. The production composition activates the
    generic removal and managed-creation owners before merge, disables the legacy merge writer, and
    activates `merge-progress` protection. Git success with cleanup resumes the same generic removal
    operation and commits task absence/count/line totals once; no-cleanup merges count nothing. The
    renderer retains recovery access but supplies no paths and performs no cleanup or local deltas.
    Canonical absence status-joins a lost Start response, durably consumes terminal access once, and
    preserves pending/manual outcomes while bounding finalizer repair to one notice.
  - proof: `electron/ipc/task-merge-operation-issuer.test.ts`,
    `electron/ipc/task-merge-workflow.test.ts`, `electron/ipc/task-git-handlers.test.ts`,
    `tests/contracts/task-merge.contract.test.ts`, `src/app/task-workflows.control.test.ts`,
    `src/app/task-merge-operation-recovery.test.ts`, `tests/browser/task-merge-progress.spec.ts`,
    `tests/browser/task-merge-progress-performance.spec.ts`, and the wired domain/workflow/bundle
    performance gates.

<a id="remote-mobile-task-creation"></a>

- `2026-08-03` remote/mobile task creation:
  - `70e8b042`
  - `99209184`
  - `b009ea58`
  - `276d9789`
  - status: `reimplemented locally and active`
  - reason: desktop and remote creation now share the durable backend creation workflow, canonical
    structural writer, operation journal, agent/shell launch owners, and post-response canonical
    projection. Remote sessions expose bounded catalog/picker data rather than workspace JSON.
    Generic managed creation, project-root creation, imported-worktree creation, and permission
    bypass are separate grants; capability results and final request admission enforce the same
    split. The durable initial-shell owner now also distinguishes a clean backend restart from an
    unclean absence with a consumed-before-effect, next-generation permit; legacy terminal tasks
    remain explicitly compatibility-owned. Coordinator creation remains trusted-local only.
  - proof: the task-creation domain/workflow/journal/runtime/preparation/remote-command suites,
    `src/remote/NewTaskView.test.tsx`, `tests/browser/remote-task-creation.spec.ts`, its performance
    companion, and `tests/harness/remote-feature-bundle-budget.test.ts`.

<a id="worktree-symlink-safety"></a>

- `2026-08-03` safe, discoverable ignored-file sharing for managed worktrees:
  - `c2c416ef`
  - `0704b8a4`
  - `72b13d59`
  - `10ebb904`
  - `223ff90a`
  - `630249d9`
  - `c9fcfff5`
  - `146578b4`
  - `054060ba`
  - broad consolidation commit `0c4f6fee` intentionally not ported
  - status: `reimplemented locally and active`
  - reason: one backend worktree-link owner now performs bounded root-only discovery, canonical
    request admission, fresh eligibility checks, literal common-exclude updates, safe link creation,
    and postcondition cleanup for both tasks and Arena. The renderer queries only in managed mode,
    trusts backend default bits rather than recreating policy, exposes bounded loading/failure/retry/
    truncation states, and summarizes typed optional warnings without treating discovery as
    authority. The existing wire channel remains for compatibility; upstream's broad Git/IPC file
    consolidation does not fit the local Electron/browser owner split.
  - proof: `electron/ipc/git-worktree-symlinks.test.ts`, its integration/cleanup/benchmark companions,
    controller/UI tests, and `tests/browser/new-task-dialog.spec.ts` cover the backend authority and
    managed-worktree-only presentation path.

<a id="terminal-search"></a>

- `2026-08-03` terminal-local search:
  - `47da4c00`
  - `d1918174`
  - status: `reimplemented locally and active`
  - reason: search is an ephemeral capability behind the existing terminal-session facade. The
    overlay owns only local presentation, the xterm addon loads on the first nonempty query, and
    focused terminal interception never enters PTY, lease, persistence, recovery, or remote/mobile
    state. The startup build graph explicitly excludes the search chunk from preload and prefetch.
  - proof: shortcut/runtime/overlay/session owner tests, the bundle guard, and
    `tests/browser/terminal-search.spec.ts` plus its deterministic performance companion cover idle
    zero-cost behavior, session cleanup, focus, byte isolation, and bounded search cost.

<a id="wrapped-terminal-links"></a>

- `2026-08-03` wrapped terminal Markdown links and task-content admission:
  - `c1037500`
  - `be340755`
  - status: `reimplemented locally and active`
  - reason: one bounded cell-aware mapper supplies the terminal facade, while activation sends only
    task/PTY identity and a relative path. The backend linearizes canonical-task and
    explicit-transient PTY authority, binds a canonical descriptor identity, revalidates lifecycle
    admission, and enforces the Markdown/plan owners' byte and path policies before returning
    content.
  - proof: mapper and session tests, task/PTY authority and bounded-file race suites, browser IPC
    validation, both committed benchmarks, and `tests/browser/terminal-links.spec.ts` cover the
    active renderer-to-backend path.

<a id="terminal-webgl-repaint-recovery"></a>

- `2026-08-03` terminal WebGL repaint recovery:
  - `07a027bb`
  - `6380f304`
  - `f87550b7`
  - status: `reimplemented locally and active`
  - reason: the WebGL pool owns a generation-safe, focused-first, one-per-frame paint repair queue
    and exact listener lifetime. macOS foreground/newly-visible repair and the lazy cross-platform
    command clear only the live atlas and viewport; remote restore refresh stays after the accepted
    write and buffered-output drain. Neither path replays terminal bytes or changes renderer/context
    ownership.
  - proof: pool, diagnostics, keybinding/session, and remote-component suites plus
    `tests/browser/terminal-webgl-repaint.spec.ts` exercise the paint-only contract and explicit DOM
    fallback evidence.

<a id="dependency-security-refresh"></a>

- `2026-08-03` dependency and supply-chain security refresh:
  - `613cc8af`, `2152592e`, `d5338956`, `a89dae30`
  - `7b77d351`, `9432faa6`, `f8db98ab`, `4410849a`, `f539d966`, `8676b49a`
  - status: `re-resolved locally and active in CI/release`
  - reason: historical upstream pins were re-resolved as coherent backend, renderer-shipped, and
    tooling lanes. One installed-lock-node exposure owner feeds both archive verification and the
    live audit policy; declaration bucket is never treated as exposure, and audit retries only
    operational failures. CI and release run the same live gate.
  - proof: exposure/audit/resource/package fixture suites plus `npm run audit:dependencies` provide
    fail-closed policy evidence; build, browser, package, and terminal gates retain behavior and
    resource proof.

- `2026-05-24` upstream catch-up (`7aaf640..6097655`):
  - `bafbd61`
  - `cc445b4`
  - `7e01cbe`
  - `c4cbbef`
  - status: `landed`
  - reason: upstream behaviors that fit local ownership were remapped into backend git/IPC owners,
    window/session owners, app workflow owners, store/presentation owners, and focused component
    owners. Large product directions remain design-only instead of direct ports.
  - validation: targeted node and Solid owner tests, `npm run typecheck`, `git diff --check`,
    `npm ls --package-lock-only ws mermaid qs`, `npm run test:browser:terminal`,
    `npm run check -- --pretty false`, and `npm test` have passed.

- backend git correctness family:
  - `c40d743`
  - `23ae2bb`
  - `246ef40`
  - status: `landed`
  - reason: local backend git owners now use merge-base semantics for diff stats, worktree status,
    and branch log, and merge now rejects stale branch mismatches before side effects
- changed-files footer correctness:
  - `777f1d7`
  - `c42b921`
  - status: `landed`
  - reason: local `ChangedFilesList.tsx` now totals only committed lines while still surfacing
    uncommitted counts whenever visible uncommitted files exist
- markdown/link hardening slice:
  - `0bc4d65` subset
  - `933931a`
  - status: `landed`
  - reason: local markdown now renders through the shared safe renderer and terminal web links now
    require modifier intent at the terminal-session owner
- terminal media/input ergonomics slice:
  - `cec983b`
  - `774ffe2`
  - status: `landed`
  - reason: current main now exposes a typed clipboard-image save seam for Electron runtimes,
    degrades explicitly in browser mode, and routes terminal-specific key ergonomics through the
    shared terminal-session shortcut owner
- bounded UI/viewer ergonomics slice:
  - `7d534ce`
  - `88b5b8f`
  - `fb86cc5`
  - bounded subset of `b944064`
  - status: `landed`
  - reason: current main registers zoom reset globally, wraps large agent rows, widens the dialog
    for large agent sets, and keeps diff readability improvements bounded to soft wrap plus
    deleted/additional-file polish that fits local review owners

- terminal markdown viewer routing:
  - `9ce6abe`
  - `a37b958`
  - status: `landed`
  - reason: terminal `.md` links now route through the owned markdown viewer path in the
    terminal-session owner instead of falling through to external handling
- Mermaid in the owned plan viewer:
  - `e56a9fc`
  - status: `landed`
  - reason: Mermaid now renders only inside the plan-viewer pipeline through local presentation
    owners and shared markdown helpers
- `91f00f4..a0f5280` git / changed-files parity subset:
  - `5f66a24`
  - `8f2ea49`
  - `e2822ea`
  - `da88063`
  - `ba03382`
  - status: `landed`
  - reason: the backend now validates local branch existence before worktree creation, filters
    phantom files against both local and remote `main`, keeps uncommitted files visible, and
    renders the changed-files tree through a presentation-only owner with keyboard and collapse
    support
- `91f00f4..a0f5280` shell / settings / shortcut subset:
  - `78c3126`
  - `85b5b90`
  - `fb6b081`
  - `eb165c3`
  - `83c677c`
  - `3f9900b`
  - `6ff5b57`
  - `bfac21e`
  - status: `landed`
  - reason: terminal typography settings now persist through the shared store, shell tabs resolve
    through the OS account shell, dialog-safe Escape stays centralized in shortcut policy, remote
    websocket failures are surfaced explicitly, the new-task dialog uses bounded tooltip guidance,
    and diff/global zoom controls are now owned locally
- `af685eb..7aaf640` task-switch shortcut subset:
  - `04d2db1`
  - status: `landed`
  - reason: the direct prev/next task shortcut is implemented through local keybinding,
    app-shortcut, and focus-navigation owners, preserving the focused panel when the target panel
    exists and falling back to the target panel default otherwise
- `af685eb..7aaf640` preload allowlist subset:
  - `08969d3`
  - `7aaf640`
  - status: `not applicable`
  - reason: current local IPC does not define `get_uncommitted_file_diffs`; preload allowlist drift
    remains guarded by the local enum/allowlist test
- `91f00f4..a0f5280` task-steps redesign:
  - `df89387`
  - `956a821`
  - `a9c000b`
  - `612590a`
  - `075a48f`
  - `e7819cc`
  - `5509606`
  - `d26c824`
  - `8b3c07f`
  - `60ce955`
  - `11d3a1e`
  - `c2ebc2d`
  - `7404cf8`
  - `9eeaaeb`
  - `a532346`
  - `dc85459`
  - `0660b9b`
  - `4e160ef`
  - `503cc25`
  - `70c60cb`
  - `a0f5280`
  - `0f12e55`
  - `b973d2b`
  - status: `landed`
  - reason: current main now treats `.claude/steps.json` as backend-owned worktree truth, replays
    compact step summaries through browser startup/reconnect, lazy-loads full history only for the
    active task-panel section, preserves explicit unchecked state, seeds the first prompt through
    the app workflow owner, and keeps next-action prefill plus shell/agent jump affordances behind
    the new task-steps owner family

Closed on current main:

- broad refactor subset:
  - `2430b97`
  - status: `covered`
  - reason: the surviving prompt-send, channel-lifecycle, storage, and persisted-agent-default
    behaviors already map to stronger current owners on `main`
- optional prompt-panel toggle:
  - `a350209`
  - status: `not_planned`
  - reason: upstream's desktop-shaped hide-toggle does not fit the current browser-shell prompt
    surface or task-panel focus model
- bounded diff-preview polish:
  - `b944064`
  - status: `covered`
  - reason: the bounded preview behavior already lives in the current
    `ScrollingDiffView` owner
- `91f00f4..a0f5280` changed-files commit-nav and diff-dialog button cluster:
  - `9f66625`
  - `08c721a`
  - `3bae1c3`
  - `efdd863`
  - `3a961c6`
  - `734da25`
  - `4fb2569`
  - `182282d`
  - status: `closed without direct port`
  - reason: this fork does not expose upstream's commit-selection button surface in the changed
    files panel; bounded file navigation already lives in the review toolbar owner, and the
    remaining folder-color / spacing polish stays local presentation work rather than a parity item
- `91f00f4..a0f5280` browser-shell utility subset:
  - `47b76ee`
  - `83bbb98`
  - `4ea5a94`
  - `cabbc6b`
  - status: `closed without direct port`
  - reason: browser cold-bootstrap and client-session reconciliation already own the dev-refresh
    restore path, task attention already flows through canonical supervision owners, the hidden
    prompt-input surface does not exist in the current browser shell, and Copilot CLI support
    remains a separate provider/product decision instead of parity work in this pass
- isolation-model implementation queue:
  - `8d30d7e`
  - `95d0f06`
  - `2b82e88`
  - `3134143`
  - status: `landed with cleanup remaining`
  - reason: current main now persists explicit `gitIsolation` and `baseBranch`, creates
    current-branch tasks through backend/workflow owners, and renders the new terminology across
    the primary task surfaces; legacy compatibility shims and remote-protocol cleanup remain

Intentional non-ports remain:

- Docker isolation family:
  - `c646df4`
  - `2be2c00`
  - `064a4ea`
  - `c456632`
  - `511af86`
  - `0a31fb7`
  - `e96fba1`
  - status: `redesign only`
  - reason: upstream implemented Docker as a desktop-local Electron/container feature; if we ever
    pursue it here, it should be reimplemented as a backend-owned runner capability for the
    web/server architecture instead
- isolation-model family:
  - `8d30d7e`
  - `95d0f06`
  - `2b82e88`
  - `3134143`
  - status: core implementation `landed`, cleanup later
  - reason: the local redesign contract in `docs/GIT-ISOLATION-MODEL-SPEC.md` is now implemented
    across the primary owners; only compatibility cleanup and later branch-selection follow-through
    remain
- terminal scroll/xterm family:
  - `60857bd`
  - `e07d69d`
  - `0882952`
  - status: intentionally `skip/defer` after reproduced-negative recheck on `2026-04-16`
  - reason: current `main` did not reproduce the scrolled-back viewport resetting to the top while
    output and fit churn overlapped; the terminal issue that still reproduces locally is frame-budget
    pressure in the render-stress suite, not the upstream scroll-reset symptom

### Upstream commits reviewed and still worth implementing

The `2026-03-13` to `2026-03-17` upstream batch was reviewed. The detailed per-commit analysis and
bring-over spec live in [UPSTREAM-CATCHUP-2026-03-19.md](./UPSTREAM-CATCHUP-2026-03-19.md).

There are no remaining upstream `bring_with_modifications` commits in `b250446..91f00f4`.
The consolidated ledger stays useful as the complete decision record, but the active engineering
queue has shifted back to current-main runtime quality and any future redesign-only product work.

## Recent Porting Lessons

Recent browser-mode and preview work reinforced rules to carry into future upstream ports:

- browser reconnect is not the same thing as authenticated replay readiness
- no-op persistence fast paths must still preserve validation and reconciliation side effects
- preview and observed-port parsing needs paired "bad string" and "nearby valid string" regressions
- shared test harness cleanup must be listener-identity-aware or suite-order flake will leak across runtime tests
- upstream request-shape changes should flow through the shared invoke request map and explicit
  optional-channel handling, not through widened per-call convenience types
- if multiple local restore or watcher paths need the same saved-state fragment, port it once into a
  shared parser instead of copying local `JSON.parse(...) as ...` shapes
- do not mark an upstream commit as covered just because a similar commit exists somewhere in repo
  history; verify coverage on current `main` or point to the exact current owner files

These are captured in more detail in [REVIEW-RULES.md](./REVIEW-RULES.md). Update that doc when a port or review teaches a reusable lesson.

### Upstream commits reviewed and intentionally skipped

These were reviewed through upstream head `b541919`, but are intentionally not treated as parity targets in this fork:

- `9902a31` `docs(readme): restructure around USPs and new tagline`
- `21c2105` `style(ui): brighten Review Plan button with subtle accent tint`
- `7ab191e` `fix(lint): resolve eqeqeq error and eliminate non-null assertions`
- `a75d0b3` `1.1.0`
- `65051a9` `style: fix prettier formatting in 10 files`
- `cb511e5` `style(themes): lighten non-minimal themes for better outdoor readability`
- `f3abdb5` `style(ui): make prompt placeholder more subtle when unfocused`
- `efdd90f` `docs: add new vid`
- `52c3be8` `docs: add intro YouTube video link to README`
- `e326596` `1.1.1`
- `c646df4` `feat: add Docker isolation mode for safer YOLO execution`
- `2be2c00` `improve: Docker isolation lifecycle, env forwarding, and UX`
- `064a4ea` `feat: add bundled Dockerfile and image build support`
- `c456632` `fix: address review findings across Docker isolation`
- `4bb68ae` `Fix ESLint no-non-null-assertion warning in pty.ts`

Docker defer note:

- this is an intentional product-direction defer, not an accidental miss
- upstream’s implementation assumes a desktop-local Docker runtime and Electron-owned process
  affordances
- if we pursue container isolation later, reimplement it as a backend-owned runner capability that
  works in our web/server architecture instead of porting upstream PTY/UI file shape
- current local task-container work follows that rule: the backend owns task/worktree-scoped
  Compose inspection and lifecycle through `electron/ipc/task-containers.ts`, while the preview
  manager consumes typed inspect results instead of local Docker heuristics

### Upstream commits reviewed and considered already covered locally

These upstream commits do not need a direct port because the behavior is already implemented locally:

- `b483e65` `fix(plans): don't show stale plans in fresh sessions`
  - local watcher behavior already snapshots existing plan files and ignores them on fresh watcher start in `electron/ipc/plans.ts`
- `53a6deb` `feat(git): show unstaged files reliably in changed files section`
  - local diff backend already uses raw diff plus untracked-file enumeration in
    [electron/ipc/git-diff-ops.ts](../electron/ipc/git-diff-ops.ts)
- `4792390` `fix: update macOS icon sizes (#21)`
  - local `build/icon.icns` now matches upstream head exactly

When upstream moves again, update this section first:

1. change the reviewed upstream head
2. list which new commits were ported, deferred, or skipped
3. keep the distinction between shared graph ancestry and selective behavioral parity explicit

## Recommended Upstream Sync Workflow

Use this workflow every time you pull in upstream work.

This is the required workflow for non-trivial upstream sync work in this repo.

### 1. Fetch and inspect first

- fetch `origin`
- compare `origin/main` against local `main`
- group upstream commits into:
  - safe small fixes
  - medium-risk ports
  - large feature clusters

Do not start by cherry-picking everything that looks useful.

### 2. Classify each commit before editing code

For every upstream commit, decide one of:

- `cherry-pick directly`
- `manual port`
- `reimplement on our architecture`
- `skip/defer`

Record that choice in your working notes or PR description if the change is non-trivial.

### Required upstream port record

For each non-trivial upstream feature or commit family, capture this mapping before or while coding:

1. upstream commit or feature slice
2. classification:
   - `cherry-pick directly`
   - `manual port`
   - `reimplement on our architecture`
   - `skip/defer`
3. behavioral intent
4. local owner:
   - backend
   - handler/transport
   - workflow/app
   - store/projection
   - presentation
5. local files or modules that should carry the change
6. validation seam:
   - node/backend
   - runtime/integration
   - Solid/UI
   - docs/sanity only

If you cannot fill this out clearly, do not start porting yet.

### 3. Map the behavior to the local owner

Before editing files, answer:

- what domain changed?
- who is the authority for that domain here?
- which local layer should own the change?

If the upstream file path does not match local ownership, follow local ownership.

### 4. Port the smallest complete behavior slice

Prefer:

- one upstream behavior at a time
- one commit family at a time
- one validation story per slice

Avoid:

- mixing unrelated upstream ports together
- carrying large UI, runtime, and backend changes in the same review chunk unless the behavior truly requires it

### 5. Review the port against local architecture

Check the result against:

- `docs/ARCHITECTURAL-PRINCIPLES.md`
- this playbook
- browser mode expectations when transport/startup/preview/auth are involved

If the final implementation lands in a different owner than you first mapped, update the record and explain why.

### 6. Validate at the correct seam

Match validation to the kind of change:

- backend logic -> node tests
- runtime/replay/startup -> node + contract/integration tests
- screen behavior -> Solid tests
- docs-only changes -> diff/link/sanity checks

### 7. Push to the writable remote only

This repo uses:

- `origin` for upstream inspection
- `fork` for pushing local work

Push final local work to `fork`, not `origin`.

## High-Level Architectural Deltas From Upstream

### 1. More backend-owned canonical state

Compared with upstream, this repo moved more durable truth into backend-owned state and replayable snapshots, especially around:

- review and convergence
- supervision and attention
- task ports and preview trust
- browser restore/bootstrap categories

Porting rule:

- if upstream computes durable truth in the renderer, prefer moving that meaning into the backend or
  into an existing canonical snapshot path here

### 2. Browser/server mode is more first-class

Compared with upstream, browser mode here is not an afterthought. It has:

- explicit control-plane state
- explicit startup/replay logic
- stronger auth/session hardening
- stricter preview trust rules

Porting rule:

- any upstream change that touches transport, startup, replay, preview, or auth must be checked
  against browser mode explicitly, not just Electron

### 3. Workflow/controller layers are more explicit

Compared with upstream, this repo intentionally pulled multi-step behavior into named workflow and controller modules.

Porting rule:

- if upstream adds multi-step logic in a component, store slice, or IPC handler, port it into an
  existing workflow/controller first and wire the UI to that

### 4. Restore and persistence are stricter

This repo prefers:

- exact identities
- explicit registration
- replay/snapshot semantics

over:

- newest-file heuristics
- ad hoc startup listeners
- best-effort local reconstruction

Porting rule:

- upstream restore changes should be mapped onto exact identifiers and existing bootstrap/session logic here

### 5. Reliability and test hardening are stricter

This repo has more explicit expectations around:

- fake timer cleanup
- watcher timing
- browser-lab coverage for terminal rendering, restore, and representative multi-client flows
- stress and diagnostics validation for browser transport, replay, and late join behavior

Porting rule:

- upstream terminal, restore, or multi-client browser changes should carry the right validation seam
  here:
  - node/contract when the backend or transport contract changes
  - Solid/UI when the desktop projection changes
  - Playwright browser lab when real browser render/focus/reload behavior is the risk

### 6. Multi-client browser coordination is more explicit

Compared with upstream, this repo treats browser collaboration state as a first-class control-plane
concern.

That includes:

- stable browser session identity and display names
- peer presence snapshots
- task takeover request/result sequencing
- passive read-only terminal/prompt UX when another client controls the task

Porting rule:

- do not port browser collaboration behavior by adding policy to dialogs, banners, or leaf
  components
- map it to the local owner instead:
  - transport/control plane for request/result fanout
  - workflow/app for takeover semantics
  - store/projection for roster and ownership labels
  - presentation for the visible affordances
- scenario reliability
- integration test stability

Porting rule:

- upstream test additions often need to be adapted so they prove the seam without depending on suite order or leaked timer state

## Decision Matrix For Upstream Commits

When an upstream commit arrives, classify it before touching code.

### 1. Cherry-pick directly

Use when:

- the change is isolated
- file ownership still matches in this repo
- it does not cross a divergence hotspot
- it does not move durable truth into the wrong layer

Typical examples:

- styling-only changes
- isolated dialog layout fixes
- local input/paste UI fixes

### 2. Manual port

Use when:

- the behavior is clearly correct
- the file paths differ
- the ownership model is still compatible after adaptation

Typical examples:

- small watcher fixes
- backend parsing fixes
- dialog UX behavior that needs to be applied to a renamed or refactored component

### 3. Reimplement on our architecture

Use when:

- upstream behavior is good but implemented through older structure
- the change crosses workflow/controller boundaries here
- the upstream file is now split across backend, handler, workflow, store, and UI layers in this repo

Typical examples:

- push/merge/review flows
- startup/restore behavior
- preview or task-port behavior
- review queue / convergence behavior

### 4. Skip or defer

Use when:

- the change conflicts with our architectural direction
- it assumes older UI/state shape
- it would add a lot of churn for limited value
- we need a separate local design first

Typical examples:

- large feature clusters built on old dialog/review internals
- hook or CI changes that are not actually shippable in this repo yet

## Port By Intent, Not By File Shape

The most important rule is:

**port the behavioral intent, not the upstream file layout**

A port is only considered complete here when all three are true:

1. the behavior is present
2. the behavior lives in the correct local owner
3. the validating tests live at the correct seam

Examples:

- upstream touches one giant git IPC file
  here the same behavior may belong across:
  - `electron/ipc/git-mutation-ops.ts`
  - `electron/ipc/task-git-handlers.ts`
  - `src/app/task-workflows.ts`
  - `src/components/*`

- upstream touches startup behavior in a top-level app file
  here the same behavior may belong in:
  - `src/app/desktop-session.ts`
  - `src/runtime/browser-session.ts`
  - `server/browser-control-plane.ts`

- upstream touches review/diff UI logic
  here the same behavior may need to pass through:
  - backend diff/review state
  - app projection
  - presentation-only components

## Mapping Guide: Common Upstream Areas To Local Homes

### Git mutations and long-running git actions

If upstream changes:

- `electron/ipc/git.ts`
- push / merge / commit / discard flows

Look here first:

- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/task-git-handlers.ts`
- `electron/ipc/git-status-workflows.ts`
- `src/app/task-workflows.ts`

### Plan discovery, watching, and restore

If upstream changes:

- plan watcher logic
- startup plan restore
- plan persistence

Look here first:

- `electron/ipc/plans.ts`
- `electron/ipc/system-handlers.ts`
- `src/app/desktop-session.ts`
- `src/store/persistence.ts`
- `src/store/tasks.ts`

### Diff and binary handling

If upstream changes:

- diff generation
- pseudo-diff rendering
- binary-file handling

Look here first:

- `electron/ipc/git-diff-ops.ts`
- `electron/ipc/git-binary.ts`
- `src/lib/diff-parser.ts`

### Push/review/merge dialog behavior

If upstream changes:

- live progress UI
- completion notifications
- dialog visibility semantics

Look here first:

- workflow/app layer for execution
- task-level component for policy
- leaf dialog for local streaming or display state

For push specifically:

- `electron/ipc/git-mutation-ops.ts`
- `electron/ipc/task-git-handlers.ts`
- `src/app/task-workflows.ts`
- `src/components/TaskPanel.tsx`
- `src/components/PushDialog.tsx`

### Runtime startup, replay, and restore

If upstream changes:

- startup hydration
- browser bootstrap
- replayable state categories
- reconnect behavior

Look here first:

- `src/app/desktop-session.ts`
- `src/runtime/server-sync.ts`
- `src/runtime/browser-session.ts`
- `server/browser-control-plane.ts`

### Supervision and task presentation

If upstream changes:

- task row status
- attention state
- supervision snapshots
- multi-agent presentation

Look here first:

- `electron/ipc/agent-supervision.ts`
- `src/app/task-presentation-status.ts`
- `src/app/task-attention.ts`
- `src/components/SidebarTaskRow.tsx`

## Divergence Hotspots

These are the files where a direct upstream cherry-pick is most likely to be wrong:

- `src/app/desktop-session.ts`
- `src/runtime/server-sync.ts`
- `server/browser-control-plane.ts`
- `electron/ipc/agent-supervision.ts`
- `electron/ipc/task-git-handlers.ts`
- `src/app/task-workflows.ts`

If an upstream commit touches one of these areas conceptually, slow down and port by intent.

## Porting Workflow

For every upstream change, follow this sequence:

1. Identify the behavioral intent.
2. Classify the change:
   - direct cherry-pick
   - manual port
   - reimplement
   - skip/defer
3. Map the affected domain to the correct local layer owner.
4. Port the smallest behaviorally complete slice.
5. Review the result against:
   - `docs/ARCHITECTURAL-PRINCIPLES.md`
   - this divergence playbook
6. Add or adapt tests at the seam where the behavior now lives.
7. Prefer a logical commit boundary that explains the port clearly.

## Validation Matrix For Ported Changes

Use this as a practical guide when deciding what to rerun after a port.

### Backend-only parsing, watcher, git, or filesystem changes

Prefer:

- targeted node tests for the touched backend modules
- relevant contract tests if the output is replayed or authoritative

Examples:

- plan watcher updates
- binary diff detection
- git mutation parsing

### Runtime, replay, restore, or startup changes

Prefer:

- targeted node tests for runtime/session/bootstrap modules
- replay/reconnect/control contract tests
- full `npm test` when the change touches shared coordination paths

Examples:

- `desktop-session`
- `server-sync`
- browser control-plane behavior

### UI-only presentation changes

Prefer:

- targeted Solid tests for the touched screen/component
- only widen to full Solid suite when the change crosses shared UI patterns or timing behavior

Examples:

- dialog scrolling
- local button behavior
- task-row visual state

### Mixed backend + renderer workflow changes

Prefer:

- backend test for execution side
- renderer test for presentation side
- at least one seam-level test if the port crosses workflow boundaries

Examples:

- streamed push output
- review freshness UI fed by backend state

### Hook, repo-policy, or toolchain changes

Prefer:

- the real command that the hook or policy is meant to protect
- not just the hook script itself

Examples:

- run `npm run check` for `pre-push`
- confirm vendored or generated code boundaries are excluded intentionally

## Do / Don't For Upstream Migration

### Do

- map upstream behavior to local ownership first
- preserve backend authority for external state
- preserve exact restore identity
- keep task-level policy above leaf dialogs
- move transport details out of presentation components
- treat browser mode as a first-class runtime when porting
- add tests where the ported behavior actually lives

### Don't

- cherry-pick large feature stacks blindly because the UI looks similar
- move backend truth back into the renderer
- let a dialog own task-level success/failure semantics
- put workflow logic into transport glue
- reintroduce one-off startup listeners for replayable state
- force upstream hook policy into this repo if the repo baseline does not actually support it yet

## Worked Examples From Recent Ports

### Example: plan watcher and exact plan restore

Commits:

- `4272366` `feat(plan): watch and restore exact generated plan files`

Why this was a manual port instead of a cherry-pick:

- upstream startup ownership differed
- this repo already had stricter persistence and desktop-session restore flow

How it was aligned here:

- backend watcher stayed in `electron/ipc/plans.ts`
- exact identity persisted as `planRelativePath`
- startup restore flowed through explicit IPC and `src/app/desktop-session.ts`

Principles applied:

- backend owns filesystem truth
- restore uses exact identity
- renderer does not guess

### Example: binary diff detection

Commits:

- `0bb2e17` `fix(diff): detect binary files in generated diffs`

Why this was aligned:

- binary detection was moved to the backend diff layer
- renderer only consumed canonical safe diff results

Principles applied:

- backend owns git/file truth
- UI does not reinterpret malformed pseudo-diff content

### Example: streamed push output

Commits:

- `b8b83cc` `feat(push): stream live git push output`

Why this needed reimplementation instead of a direct cherry-pick:

- upstream push logic assumed older IPC and dialog structure
- this repo already split git mutation, handler, workflow, and presentation ownership

How it was aligned here:

- backend owns `git push --progress`
- handler binds optional output channel
- workflow owns transport-facing channel creation
- `TaskPanel.tsx` owns task-level completion notification policy
- `PushDialog.tsx` owns only local output rendering and close/cancel UI

Principles applied:

- transport is not business logic
- leaf dialogs do not own task-level policy
- backend owns long-running process execution

### Example: hook parity

Commits:

- `54a4499` `chore(checks): mirror CI in pre-push and ignore vendored Hydra`

Why this was not a direct upstream copy:

- the repo baseline initially could not support a full `npm run check` gate because vendored Hydra was outside our local lint/format policy
- putting `npm run check` into `pre-commit` would also have been too heavy

How it was aligned here:

- `pre-commit` stays fast and staged-file focused
- `pre-push` mirrors the real repo-quality gate
- vendored Hydra is explicitly excluded from local repo-quality baselines

Principles applied:

- repo policy should match real ownership
- external vendored code is not treated as locally maintained source

### Example: wrapped terminal Markdown links

Commits:

- `c1037500` links spanning wrapped terminal rows
- `be340755` wide-character and phantom-cell correctness

Why this was reimplemented instead of copied:

- upstream colocated terminal parsing, cell mapping, activation, and broad path-opening assumptions
- this repo shares one terminal facade across Electron/browser surfaces and requires backend task
  lifecycle authority for task-content reads

How it is aligned here:

- `src/lib/terminal-links.ts` owns one pure, bounded logical-line and cell mapper
- activation carries task/PTY selectors and a relative path, never a renderer-selected root
- backend task/PTY generations, canonical descriptor identity, symlink containment, and byte caps
  decide whether Markdown or plan content can be returned
- Arena transient roots require a one-shot capability issued by the backend worktree workflow

Principles applied:

- renderer parsing is an affordance, not filesystem authority
- lifecycle withdrawal wins before asynchronous cleanup
- one pure mapper and one bounded file primitive keep policy local and independently testable

### Example: terminal WebGL repaint recovery

Commits:

- `07a027bb` clear the xterm WebGL atlas when returning to the foreground and expose manual redraw
- `6380f304` restore remote terminal painting after scrollback writes
- `f87550b7` repaint retained WebGL terminals when they become visible

Why this was reimplemented instead of copied:

- app- or component-level redraw listeners would duplicate visibility truth and reach across the
  existing WebGL context owner
- replaying output for a paint-only failure would conflate renderer corruption with terminal-byte
  recovery

How it is aligned here:

- `src/lib/webglPool.ts` owns one bounded, generation-safe, focused-first repair queue and its three
  listeners; automatic work is macOS-only and the lazy manual action is cross-platform
- the pool clears only its exact live addon and refreshes at most one eligible surface per frame,
  without acquiring, evicting, replaying, or requesting recovery
- remote/mobile repaint remains local to `AgentDetail`: accepted recovery writes drain buffered live
  writes, then one exact-identity refresh runs; stale and non-write completions do nothing

Principles applied:

- presentation repair stays with the resource owner
- paint corruption never becomes byte recovery
- bounded queues, explicit generations, and aggregate diagnostics make failure and cost observable

## Review Checklist For Future Upstream Ports

Before merging a ported upstream change, ask:

1. Did we port the behavior or just the file shape?
2. Who owns the changed domain here?
3. Did the port preserve one authority?
4. Did any component pick up transport or durable domain logic?
5. Did any transport/handler file start owning workflow logic?
6. Did restore/persistence stay exact?
7. Did we account for browser mode if the change crosses runtime boundaries?
8. Are tests proving the behavior at the right seam?
9. Would the commit message explain the port clearly to a future sync pass?
10. Could a future contributor identify the local owner for this behavior without rediscovering the port?

## PR Checklist For Upstream Sync Work

Include these in a PR description or review notes when the port is non-trivial:

1. Which upstream commits or behaviors were reviewed?
2. Which ones were cherry-picked, manually ported, reimplemented, or deferred?
3. What was the behavioral intent of each non-trivial port?
4. Which local modules now own the behavior?
5. What principle was most relevant to the placement?
6. What validation seam was used?
7. What validation was run?
8. Did browser mode require separate attention?
9. Is there any follow-up upstream work that should be handled later as a separate feature cluster?

## Relationship To Other Docs

- ownership and layering rules:
  - `docs/ARCHITECTURAL-PRINCIPLES.md`
- current runtime/data-flow walkthrough:
  - `docs/ARCHITECTURE.md`
- test strategy:
  - `docs/TESTING.md`

If these documents disagree, prefer:

1. `ARCHITECTURAL-PRINCIPLES.md` for ownership rules
2. `UPSTREAM-DIVERGENCE.md` for porting strategy
3. `ARCHITECTURE.md` for current implementation shape
4. `TESTING.md` for validation guidance
