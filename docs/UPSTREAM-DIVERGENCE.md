# Upstream Divergence Playbook

This document explains how Parallel Code has diverged from the upstream repository and how to port upstream changes without reintroducing architecture churn.

Use it when:

1. reviewing upstream commits
2. deciding whether to cherry-pick, manually port, or reimplement a change
3. mapping an upstream file change onto this repo's newer architecture
4. explaining why a direct cherry-pick is the wrong tool even when the product behavior is still desirable

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first for the ownership rules. Use this document for the practical "how do we migrate upstream work into this fork?" playbook.
Use [REVIEW-RULES.md](./REVIEW-RULES.md) for the recurring review traps and validation rules we have learned while doing those ports.

## Why This Fork Diverged

This fork did not diverge accidentally. It diverged to support a stricter architecture and runtime model:

- backend-owned canonical state for more domains
- stronger browser/server parity
- more explicit runtime controllers and workflows
- stricter startup, restore, replay, and persistence semantics
- better reliability, scenario coverage, and test hardening
- clearer boundaries between transport, workflow, store, and UI

That means some upstream changes still map cleanly, but many should now be ported by intent rather than by file shape.

## The Core Divergence

In upstream, useful behavior sometimes still lands in large UI components, broad IPC files, or older startup wiring.

In this repo, the direction is:

- backend owns external truth
- handlers validate and route
- workflow/app modules coordinate multi-step behavior
- store projects canonical state into UI-facing models
- components present and manage local ephemeral UI state

The same feature may therefore live in different files here even when the user-facing behavior is the same.

## Important Practical Difference

This repo currently uses:

- `origin` as the upstream read-only repository
- `fork` as the writable remote

That matters because upstream sync work should be reviewed against our architecture first and then pushed to `fork`, not blindly mirrored onto `origin`.

## Current Upstream Sync Status

As of `2026-03-15`, this repo has:

- last reviewed upstream head: `a75d0b3` (`v1.1.0`)
- last shared graph ancestor with upstream: `b250446`

Important nuance:

- parity after `b250446` is selective, not contiguous
- this fork intentionally ports some upstream commits by behavior while deferring or reimplementing others
- do not assume "we are synced through commit X" unless the commits in that range were either cherry-picked directly or explicitly reimplemented here

### Upstream commits intentionally brought into this fork

The following upstream behaviors from the `2026-03-12` to `2026-03-15` batches were reviewed and brought in here:

- `524750c` `fix(terminal): prevent paste duplication in shell terminals`
  - local port: `3fb9476`
- `ee8cd61` `fix(merge): make commit list scrollable in merge dialog`
  - local port: `3fb9476`
- `d3bca6e` `fix(plan): watch both .claude/plans and docs/plans for plan files`
  - local port family: `4272366`
- `f745408` `feat(plan): ignore pre-existing plans in watcher detection`
  - local port family: `4272366`
- `588e34f` `fix(plan): persist planFileName and restore exact file on restart`
  - local port family: `4272366`
- `2278c82` `fix(plan): restore plan content from disk on app restart`
  - local port family: `4272366`
- `9ba275a` `fix(plan): add path validation, log errors, unexport internal function`
  - local port family: `4272366`
- `a192f98` `fix(diff): exclude binary files from diff view`
  - local port family: `0bb2e17`
- `bba36dd` `fix(diff): detect binary files in untracked pseudo-diff generation`
  - local port family: `0bb2e17`
- `30365c6` `style(sidebar): write app title as "ParallelCode" in logo`
  - local port: `7eaf045`
- `ae858a6` `feat(push): stream live git push output in push dialog`
  - local port family: `b8b83cc`, `aed8308`, `ea19800`
- `9b31b20` `chore(hooks): mirror CI checks in pre-commit and pre-push hooks`
  - local port: `54a4499`
- `eb21feb` `feat(dialogs): keyboard navigation for diff and plan viewer dialogs`
  - local port family: `facaf70`, `86160d2`
- `31b7606` `feat(plan): add plan review dialog with syntax highlighting and inline feedback`
  - local port: `86160d2`
- `5c5766b` `feat(plan): float Review Plan button over inline plan and shrink dialog`
  - local port family: `86160d2`
- `7505c3f` `fix(plan): remove opacity from floating Review Plan button`
  - local port family: `86160d2`
- `408dd9d` `fix(plan): use opaque hover background for Review Plan button`
  - local port family: `86160d2`
- `cc3f9c7` `feat: scrolling diff viewer with search, collapse, and syntax highlighting`
  - local port family: `facaf70`
- `7dc1f4f` `feat(diff): add ask-about-code feature with inline Q&A cards`
  - local port family: `facaf70`
- `34998db` `feat(diff): add inline code review with annotations and agent submission`
  - local port family: `facaf70`, `05aa66f`
- `c126a48` `fix(diff): address code review findings`
  - local port family: `facaf70`, `05aa66f`
- `9d3d79b` `fix(diff): show truncation notice when ask-code response exceeds limit`
  - local port family: `facaf70`
- `d245dce` `feat(nav): make shell toolbar buttons individually navigable via Alt+Arrow`
  - local port family: `src/store/focus.ts`, `src/components/task-panel/TaskShellSection.tsx`, `src/app/task-workflows.ts`
- `3588b20` `fix(ci): increase Node.js heap size for macOS release build`
  - local port family: `.github/workflows/release.yml`

### Upstream commits reviewed and still worth implementing

No notable upstream behavior gaps remain from the reviewed `a75d0b3` (`v1.1.0`) head.

## Recent Porting Lessons

Recent browser-mode and preview work reinforced a few rules that should be carried into future upstream ports:

- browser reconnect is not the same thing as authenticated replay readiness
- no-op persistence fast paths must still preserve validation and reconciliation side effects
- preview and observed-port parsing needs paired "bad string" and "nearby valid string" regressions
- shared test harness cleanup must be listener-identity-aware or suite-order flake will leak across runtime tests
- upstream request-shape changes should flow through the shared invoke request map and explicit optional-channel handling, not through widened per-call convenience types
- if multiple local restore or watcher paths need the same saved-state fragment, port it once into a shared parser instead of copying local `JSON.parse(...) as ...` shapes

These are captured in more detail in [REVIEW-RULES.md](./REVIEW-RULES.md). Update that doc when a port or review teaches a reusable lesson.

### Upstream commits reviewed and intentionally skipped

These were reviewed through upstream head `a75d0b3`, but are intentionally not treated as parity targets in this fork:

- `9902a31` `docs(readme): restructure around USPs and new tagline`
- `21c2105` `style(ui): brighten Review Plan button with subtle accent tint`
- `7ab191e` `fix(lint): resolve eqeqeq error and eliminate non-null assertions`
- `a75d0b3` `1.1.0`

### Upstream commits reviewed and considered already covered locally

These upstream commits do not need a direct port because the behavior is already implemented locally:

- `b483e65` `fix(plans): don't show stale plans in fresh sessions`
  - local watcher behavior already snapshots existing plan files and ignores them on fresh watcher start in `electron/ipc/plans.ts`

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

That means the final push target should be `fork`, not `origin`.

## High-Level Architectural Deltas From Upstream

### 1. More backend-owned canonical state

Compared with upstream, this repo moved more durable truth into backend-owned state and replayable snapshots, especially around:

- review and convergence
- supervision and attention
- task ports and preview trust
- browser restore/bootstrap categories

Porting rule:

- if upstream computes durable truth in the renderer, prefer moving that meaning into the backend or into an existing canonical snapshot path here

### 2. Browser/server mode is more first-class

Compared with upstream, browser mode here is not an afterthought. It has:

- explicit control-plane state
- explicit startup/replay logic
- stronger auth/session hardening
- stricter preview trust rules

Porting rule:

- any upstream change that touches transport, startup, replay, preview, or auth must be checked against browser mode explicitly, not just Electron

### 3. Workflow/controller layers are more explicit

Compared with upstream, this repo intentionally pulled multi-step behavior into named workflow and controller modules.

Porting rule:

- if upstream adds multi-step logic in a component, store slice, or IPC handler, port it into an existing workflow/controller first and wire the UI to that

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
