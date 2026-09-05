# Product Validation Objectives

This document turns the product promise into review behavior.

Read it before choosing architecture, tests, or browser-lab coverage for a user-facing change.

This document owns:

- user-frustration taxonomy
- product-level validation objectives
- when to minimize or require real browser proof from the user's perspective

This document does not own:

- architecture ownership rules
- exact test commands
- terminal/browser-lab runbooks
- upstream porting policy

For ownership, use [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md). For validation
layers and sufficiency, use [TESTING.md](./TESTING.md). For terminal and browser-lab workflow, use
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).
For the implementation-first performance plan, use
[PRODUCT-PERFORMANCE-EXECUTION-PLAN.md](./PRODUCT-PERFORMANCE-EXECUTION-PLAN.md).
For the current objective-to-evidence audit, use
[PRODUCT-GOAL-AUDIT-2026-05-08.md](./PRODUCT-GOAL-AUDIT-2026-05-08.md).

## Active Goal

Make Parallel Code the browser-first developer cockpit for solo developers and small teams running
many AI coding agents at once. The selected task, terminal, diff, preview, and remote session should
be immediately usable and desktop-native even under load. Users should have no ambiguity about who
controls the task, what is running, what is exposed, what changed, what is stale, what needs
attention, and why something is blocked.

Browser/server mode is the product baseline. Electron is only a platform adapter. Preserve the
browser capabilities that define the product: safe remote access, explicit preview and port exposure
for remote browser-app testing, multi-client control and takeover, and replayable backend state.
Keep ownership simple: backend owns external truth, renderer owns presentation and workflow, and
transport never owns domain policy.

The immediate performance objective starts in product code. Use the browser/server scorecard and
low-overhead diagnostics to find the slowest real user journeys. Then experiment on those runtime
paths until selected terminal use, task switching, review, preview, remote, reconnect, and cleanup
flows meet explicit product budgets. Validate from user frustration first. Use the cheapest reliable
owner-local proof while iterating, and reserve real browser tests for risks that only a browser can
expose: focus, paint, navigation, cookies, websocket auth/bootstrap, and multi-context coordination.

## Product Promise

Parallel Code should feel like a command center for many AI coding workflows:

- fast enough that typing, task switching, diff selection, and preview opening feel immediate
- dense enough for power users without hiding ownership, status, or next actions
- browser-first without forcing desktop-style startup and restore semantics into the browser
- remote-capable without surprising users by exposing terminals, previews, or project state
- trustworthy enough that review, git, preview, and recovery state are authoritative

The default answer to product tradeoffs is:

1. Keep the selected surface useful immediately.
2. Keep terminal input responsive under load.
3. Keep user control and backend authority visible before making flows clever.
4. Treat browser/server mode as the baseline and Electron as a platform adapter.
5. Preserve advanced browser capabilities without silent exposure or opaque takeover.
6. Prove behavior with the thinnest valid seam before paying for Playwright.
7. Run real browser proof when the user-visible risk only exists in a real browser.

## Success Criteria

Treat these as review criteria, not a claim that every product surface already satisfies them.

| Requirement                     | Done when                                                                                           | Primary proof direction                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Browser-first developer cockpit | Browser/server mode is a first-class runtime and Electron only adapts platform affordances.         | Architecture ownership review plus targeted browser canaries for browser-only behavior.                     |
| Desktop-class felt speed        | Terminal input, task switching, file review, previews, and remote sessions respond without drag.    | Owner-local latency seams first, with browser timing proof only for focus, paint, visibility, or transport. |
| Legible user control            | Control, running, exposed, changed, stale, attention, and blocked states are visible from owners.   | Backend/control-plane contracts plus Solid projection tests for banners, chips, dialogs, and review states. |
| Backend authority               | Git, filesystem, PTYs, previews, ports, review signals, and multi-client control stay server-owned. | Backend tests and source review at transport boundaries.                                                    |
| Selected-surface-first startup  | The selected task and active terminal become useful before background restore competes for time.    | Startup tier tests and targeted bootstrap canaries when painted readiness or reconnect changes.             |
| Advanced browser capabilities   | Safe remote access, port exposure, multi-client takeover, and replayable state remain intact.       | Protocol, lease, proxy, and replay tests, with multi-context browser proof for real coordination changes.   |
| Task-note continuity            | Desktop and remote edits never silently overwrite a newer note or lose an unsafe local draft.       | Pure conflict/recovery proof, both-host service integration, and real multi-client/reconnect canaries.      |
| Lean validation                 | Review starts from user frustration and uses the thinnest reliable proof before expensive browsers. | Review notes name the pain, owner, validation seam, and any intentionally skipped browser lanes.            |

## User-Frustration Decisions

These are the accepted defaults for the current planning pass.

| User frustration                                         | Product objective                                                                              | Default answer                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "I typed and it lagged."                                 | Terminal input stays latency-critical, even while other agents are noisy.                      | Prioritize typing responsiveness over background terminal throughput.                                                     |
| "I switched tasks and the terminal was stale."           | The selected task and terminal become useful before background restore work competes for time. | Keep selected-surface-first startup and restore policy.                                                                   |
| "I do not know who controls this terminal."              | Ownership is legible and input authority is predictable.                                       | Keep explicit leases and takeover instead of silent stealing.                                                             |
| "I asked for a shell and an AI agent started."           | Task execution intent is explicit and survives restore.                                        | Persist task mode directly; never infer it from live agent or shell counts.                                               |
| "I thought this task was isolated."                      | Project-root and imported-worktree locations are unmistakable and cleanup-safe.                | Keep Git location independent from task mode, visibly flag project-root work, and preserve user-owned worktrees.          |
| "A remote browser changed my local work."                | Remote and browser clients are peers with explicit identity and bounded authority.             | Keep remote/mobile/browser clients behind identity, presence, and task-command leases.                                    |
| "The preview opened but my app was broken."              | Exposed previews preserve paths, assets, redirects, and cookies while protecting app auth.     | Route previews through the owned proxy boundary and strip Parallel Code auth before forwarding.                           |
| "The app exposed something unexpectedly."                | Remote preview exposure is explicit or task-scoped, visible, and revocable.                    | Do not allow arbitrary silent localhost proxying.                                                                         |
| "I lost trust in the diff."                              | Review state is fresh and correct before it is visually polished.                              | Keep git/review truth backend-owned and advisory signals clearly labeled.                                                 |
| "It says reconnecting forever."                          | Every transitional state has one owner, one explanation, and one deterministic exit.           | Model reconnecting, restoring, unavailable, auth-expired, and flow-controlled states explicitly.                          |
| "I cannot tell whose fault this is."                     | Errors name the likely owner: agent, git, preview target, auth, network, or runtime.           | Classify failures at the owner seam and render that classification plainly.                                               |
| "Slow gates delay fixes to daily pain."                  | Validation is fast enough that user-visible fixes keep moving without skipping real proof.     | Use the cheapest valid seam first; reserve browser runs for browser-only risk.                                            |
| "It works in Electron but not in browser."               | Browser correctness remains a release promise.                                                 | Every browser-impacting change needs either sufficient non-browser proof or a targeted canary.                            |
| "My task notes disappeared or overwrote someone else's." | Notes remain durable and conflicts preserve the complete local draft.                          | Keep one backend content-CAS writer, content-free invalidation plus authoritative refetch, and explicit recovery actions. |

## Pain-To-Proof Matrix

The test decision starts from user pain, then maps to the owner and the thinnest proof.

| Pain area                 | Prove cheaply first                                                                                                | Escalate to real browser when                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Terminal typing latency   | terminal input/output pipeline tests, scheduler/runtime tests, server latency and session-stress seams             | browser input, focus, visibility, render timing, or noisy-background behavior changed               |
| Task/terminal switching   | startup-tier, attach-scheduler, recovery-runtime, and persistence ordering tests                                   | cold bootstrap, reconnect restore, hidden/visible terminal lifecycle, or painted readiness changed  |
| Task launch intent        | discriminated launch, persistence migration, backend Git admission, and Solid mode/location tests                  | browser form interaction, focus, or response-loss retry behavior is the actual risk                 |
| Multi-client control      | task-command lease contracts, control-plane tests, browser-session lifecycle tests, Solid banner/dialog tests      | real multi-client, remote/mobile, websocket replay, or browser focus ownership changed              |
| Remote/mobile shell       | protocol parsing, remote state projection, remote command lease tests, remote UI component tests                   | remote route auth, mobile shell behavior, or multi-context browser behavior changed                 |
| Task-note continuity      | pure reducer/controller, canonical service, protected-field, scoped-gateway, and host-adapter tests                | real remote save/conflict, reconnect, terminal preservation, or multi-client event ordering changed |
| Preview and port exposure | preview route parsing, proxy header/cookie/base-path rewriting, task-port exposure tests, PreviewPanel UI tests    | real browser navigation, cookies, iframe/window behavior, or deployed proxy behavior is the risk    |
| Review and diffs          | backend git/review diff tests, review contracts, review app projection tests, ReviewPanel Solid tests              | the browser server review flow or real navigation through the review surface changed                |
| Reconnect and restore     | state-machine tests for reconnecting, restoring, unavailable, auth-expired, flow-controlled, and recovery-required | actual browser reconnect, visibility, auth expiry, or transport churn changed                       |
| Error ownership           | backend classification tests plus Solid copy/state-transition tests                                                | classification depends on live browser transport or remote runtime behavior                         |
| Product screen polish     | Solid/jsdom tests for real state transitions and architecture/source tests for ownership boundaries                | browser layout, focus, visibility, or app-shell integration is the actual risk                      |

## Fast Command Lanes

These are starting points, not mandatory universal gates. Use the narrowest lane that proves the
owner and risk, then broaden only when the changed surface justifies it. `package.json` remains the
source of truth for exact script definitions.

| Product surface                   | Start with                                                                                                                                                                                                                                              | Escalate when                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review discipline                 | `npm run validate:pr-description`, `npm run test:validation-guards`, and `npm run test:architecture-guards`                                                                                                                                             | Pair with `npm run check` before review when code changed.                                                                                                                         |
| Docs / tooling only               | `npm run format:check` and `git diff --check`                                                                                                                                                                                                           | Add targeted tests only when tooling behavior changed.                                                                                                                             |
| Terminal typing and switching     | `npm run test:node:file -- src/app/terminal-focused-input.test.ts src/app/terminal-output-scheduler-policy.test.ts src/app/terminal-attach-scheduler.test.ts src/components/terminal-view/terminal-input-pipeline.test.ts`                              | Add `npm run test:browser:terminal` when real focus, paint, restore, or visibility changed.                                                                                        |
| Terminal responsiveness tuning    | owner-local tests first, then `npm run profile:terminal:ui-fluidity:gate` as a loaded browser evidence generator with explicit artifact budget observations                                                                                             | Add `npm run profile:terminal:ui-fluidity:dense-gate` for dense visible-terminal risk; use `--fail-on-budget` only when a branch is explicitly trying to satisfy that loaded lane. |
| Review and diffs                  | `npm run test:node:file -- tests/contracts/review-diff.contract.test.ts src/app/review-diffs.test.ts src/app/review-files.test.ts`                                                                                                                      | Add `npm run test:solid:file -- src/components/ReviewPanel.test.tsx` or `npm run profile:review:diffs` when UI cost changed.                                                       |
| Preview and port exposure         | `npm run test:node:file -- server/browser-preview.test.ts electron/ipc/task-ports.test.ts src/app/task-ports.test.ts`                                                                                                                                   | Add `npm run test:solid:file -- src/components/PreviewPanel.test.tsx` or `npm run test:browser:preview` when real navigation, cookies, redirects, or iframes changed.              |
| Task deletion cleanup             | `npm run test:node:file -- src/store/task-state-cleanup.test.ts src/app/task-workflows.control.test.ts`                                                                                                                                                 | Add `npm run test:browser:task-deletion` when real browser deletion, review panel, preview panel, or browser IPC cleanup changes.                                                  |
| Remote and multi-client control   | `npm run test:contracts`; use `npm run perf:scorecard:smoke` when remote command-session responsiveness is the product risk.                                                                                                                            | Add `npm run test:browser:remote` or `npm run test:browser:canaries` for real multi-context browser coordination.                                                                  |
| Task notes                        | Focused domain/service/gateway/controller tests plus `TaskNotesFilesSection.test.tsx` and `TaskNotesView.test.tsx`; use the exact proof manifest for release freshness.                                                                                 | Add `remote-task-notes.spec.ts` and `task-notes-performance.spec.ts` when remote transport, reconnect, terminal retention, conflict UX, or input latency changed.                  |
| Startup, restore, and replay      | `npm run test:node:file -- src/app/server-state-bootstrap.test.ts src/app/session-bootstrap-controller.test.ts src/app/desktop-session.test.ts`; use `npm run perf:scorecard:smoke` when reconnect selected-surface responsiveness is the product risk. | Add `npm run test:browser:canaries` when real browser cold bootstrap, reconnect restore, or browser-side websocket auth/bootstrap handling changed.                                |
| Broad local pre-review confidence | `npm run check` and `npm test`                                                                                                                                                                                                                          | Add focused browser lanes only for browser-only risks named above.                                                                                                                 |

## Playwright Minimization Rules

Use Playwright when confidence requires a real browser condition:

- real focus or keyboard ownership
- real visibility and hidden-tab behavior
- real rendering, paint, or terminal canvas behavior
- real browser navigation, cookies, redirects, and preview proxy behavior
- real websocket/auth/bootstrap interaction
- real multi-context or remote/mobile coordination
- user-perceived responsiveness that cannot be represented by owner-local timing seams

Do not use Playwright as the first proof for:

- parser behavior
- IPC request validation
- backend state machines
- git or filesystem truth
- store projection shape
- pure component rendering
- copy/state transitions that Solid/jsdom can exercise directly

When a real browser or latency gate fails on a loaded machine, isolate-rerun the exact failing case
once before changing product code or weakening the assertion. Treat the first failure as a signal,
not yet as proof of a product regression.

For performance work, prefer semi-micro integration proof before broad browser repetition: measure
the owner seam that explains the user pain, such as bootstrap projection time, terminal attach
scheduling, renderer paint readiness, terminal write-shape/render-commit pressure, diff shaping,
proxy response timing, remote command acknowledgement, or websocket replay. Use the browser
scorecard to confirm the full journey after the local seam improves, and keep both artifacts when
browser timing is visibly load-sensitive. When a new diagnostic split changes the product direction,
first verify its internal attribution and record rejected product-code experiments in the execution
plan so future passes do not repeat known-regressive paths.

## Review Flow

For non-trivial changes, use this order:

1. Name the user frustration the change could create.
2. Map it to the product objective above.
3. Map the behavior to the owning layer.
4. Choose the thinnest validation seam that can expose the same failure.
5. Escalate to Playwright only if a browser-only condition remains unproven.
6. In review notes, list browser lanes that were intentionally not run and why.
