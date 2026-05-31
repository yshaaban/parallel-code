# Product Goal Audit 2026-05-08

This is the prompt-to-artifact checklist for the active product objective in
[PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md).

Status: **not complete as a product goal**. The active goal is now sharpened around the
browser-first developer cockpit, selected-surface readiness, terminal responsiveness, visible user
control, browser/server as the baseline, simple ownership, and product-code-first performance
evidence.

The core architecture has strong evidence for browser-first control, startup, restore, and
server-owned state. The broader promise of desktop-class responsiveness across the main user
surfaces still needs measured browser/server scorecard proof. The implementation plan for closing
that gap lives in [PRODUCT-PERFORMANCE-EXECUTION-PLAN.md](./PRODUCT-PERFORMANCE-EXECUTION-PLAN.md).

## Checklist

| Objective requirement                             | Current evidence                                                                                                                                                                                                                                                                                                                                                 | Status                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser-first developer cockpit                   | Browser/server runtime, cold bootstrap, websocket control plane, remote/mobile shell, and browser artifact test runners are first-class paths in `package.json`, `server/*`, `src/runtime/*`, `src/app/browser-startup.ts`, and `docs/BROWSER-BOOTSTRAP-REDESIGN.md`.                                                                                            | Strong evidence                                                                                                                                                                                                                                        |
| Coordinate many AI coding agents                  | PTY-backed agents, task command leases, peer presence, takeover workflows, supervision, convergence, and session-stress tests exist across `electron/ipc/*`, `server/*`, `src/app/*`, and `tests/contracts/*`.                                                                                                                                                   | Strong evidence                                                                                                                                                                                                                                        |
| Selected task becomes useful immediately          | Selected-surface-first startup policy, startup-tier tests, terminal attach scheduling, bootstrap projection tests, task-switch focus tests, task-panel/dialog delayed-focus cancellation, and notification-click focus tests cover the chosen task before hidden/background restore work.                                                                        | Strong evidence; keep measuring                                                                                                                                                                                                                        |
| Desktop-class terminal responsiveness             | `src/app/terminal-interactivity-governor.ts`, terminal scheduler/pipeline owners, shortcut browser-terminal bypass tests, latency tests, session stress tests, terminal browser matrix, benchmarks, and profiler scripts exist.                                                                                                                                  | Strong evidence; keep measuring                                                                                                                                                                                                                        |
| Desktop-class task switching                      | Selected-surface-first startup, terminal switch-window tests, visible-set/tiering tests, browser terminal restore specs, and direct task-switch / positional-jump focus-owner tests exist.                                                                                                                                                                       | Strong evidence; keep measuring                                                                                                                                                                                                                        |
| Desktop-class file review                         | Backend-owned convergence, review state, review signals, commit history, changed-file/diff contracts, review panel tests, review diff frame-cancellation tests, and review browser lifecycle specs exist.                                                                                                                                                        | Strong evidence                                                                                                                                                                                                                                        |
| Desktop-class preview opening                     | Task-port snapshots, preview probe diagnostics, preview proxy tests, preview panel tests, task-panel preview focus-control tests, port exposure flows, and a focused browser preview-proxy canary exist.                                                                                                                                                         | Strong evidence; keep browser proof focused on routing, cookies, iframe/window, and navigation risks                                                                                                                                                   |
| Desktop-class remote sessions                     | Remote bootstrap/mobile specs, remote status contracts, validated peer-presence projection, remote detail fit-frame / stale-takeover / stale-send tests, remote session-name focus-frame cancellation tests, remote collaboration projections, and websocket/control-plane contracts exist.                                                                      | Strong evidence; multi-context proof needed for coordination changes                                                                                                                                                                                   |
| Clear user control                                | Task command controller state, explicit leases, takeover request/result flows, visual-state tests, and multi-client browser specs exist.                                                                                                                                                                                                                         | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: who controls a task             | Task command controller snapshots, peer presence, task-control visual state, lease tests, and takeover contracts exist.                                                                                                                                                                                                                                          | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: what is running                 | Agent supervision snapshots, task presentation status, activity-clock tests, and task panel projections exist.                                                                                                                                                                                                                                                   | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: what is exposed                 | Task ports, preview panel exposure state, browser preview proxy tests, and remote/mobile preview projections exist.                                                                                                                                                                                                                                              | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: what changed                    | Git status, convergence, task review state, review signals, commit history, push completion identity, and review diff contracts exist.                                                                                                                                                                                                                           | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: what is stale                   | Versioned server-state replacement/event helpers, stale-event tests, build-artifact freshness checks, path-picker/new-task stale-load tests, stale destructive git-dialog validation tests, and review/merge stale-state tests exist.                                                                                                                            | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: what needs attention            | Agent supervision, task attention, task presentation status, task steps summaries, notification capability/runtime tests, notification claim coordination, and notification-click focus handoff exist.                                                                                                                                                           | Strong evidence                                                                                                                                                                                                                                        |
| State legibility: why something is blocked        | Recovery-required, flow-control, auth-expired, unavailable, remote-status, task-control, and permission-request blockers have explicit owner seams and focused tests across terminal recovery, control-plane, remote-status, and task-panel controller coverage.                                                                                                 | Strong evidence                                                                                                                                                                                                                                        |
| Backend authority for git and filesystem          | Git, diff, commit history, plan, task steps, persistence, and workflow owners live in `electron/ipc/*` with backend tests.                                                                                                                                                                                                                                       | Strong evidence                                                                                                                                                                                                                                        |
| Backend authority for PTYs                        | PTY lifecycle, pause reasons, supervision, and terminal recovery are backend-owned with node/browser proof.                                                                                                                                                                                                                                                      | Strong evidence                                                                                                                                                                                                                                        |
| Backend authority for previews and ports          | Port observation/exposure, task container preview derivation, and preview proxying are backend/server owned.                                                                                                                                                                                                                                                     | Strong evidence                                                                                                                                                                                                                                        |
| Backend authority for review signals              | Task review state, review signals, convergence, and commit history are backend-owned and replayable.                                                                                                                                                                                                                                                             | Strong evidence                                                                                                                                                                                                                                        |
| Backend authority for multi-client control        | Browser control plane, task command leases, takeover workflows, peer presence, and contracts own control semantics.                                                                                                                                                                                                                                              | Strong evidence                                                                                                                                                                                                                                        |
| Electron remains a platform adapter               | Product and architecture docs now name browser/server as the baseline, while architecture principles keep external truth in backend owners; `src/app/server-state-bootstrap-registry.test.ts` guards that browser registry listener categories keep an Electron listener path instead of introducing split ownership.                                            | Documented and source-guarded                                                                                                                                                                                                                          |
| Selected-surface-first browser startup            | `docs/BROWSER-BOOTSTRAP-REDESIGN.md`, cold bootstrap projection, startup tiers, terminal attach scheduler, and browser startup/restore tests cover the policy.                                                                                                                                                                                                   | Strong evidence                                                                                                                                                                                                                                        |
| Avoid desktop-style restore-heavy browser startup | Browser cold bootstrap is separate from reconnect restore; browser-local client session restore happens after server projection; hidden attach is deferred.                                                                                                                                                                                                      | Strong evidence                                                                                                                                                                                                                                        |
| Safe remote access                                | Remote access workflows, remote status contracts, auth, bootstrap specs, explicit status projection, and stale remote QR generation tests exist.                                                                                                                                                                                                                 | Strong evidence                                                                                                                                                                                                                                        |
| Preview and port exposure                         | Explicit task-port exposure, preview proxy tests, backend probe diagnostics, and stale diagnostics-reset guards exist; arbitrary silent localhost proxying is rejected by product policy.                                                                                                                                                                        | Strong evidence                                                                                                                                                                                                                                        |
| Multi-client takeover                             | Lease, takeover, peer presence, and multi-client browser specs exist.                                                                                                                                                                                                                                                                                            | Strong evidence                                                                                                                                                                                                                                        |
| Replayable state                                  | Shared server-state bootstrap, browser control state, reconnect replay contracts, and versioned store replacement helpers exist.                                                                                                                                                                                                                                 | Strong evidence                                                                                                                                                                                                                                        |
| User-frustration-first validation                 | `docs/PRODUCT-VALIDATION-OBJECTIVES.md`, `docs/TESTING.md`, `docs/REVIEW-RULES.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `scripts/validate-pr-description.mjs`, `npm run validate:pr-description`, `npm run test:validation-guards`, and `npm run test:architecture-guards` now encode and check pain-to-proof review flow.                                       | Guardrails reject missing, misplaced, unknown-checkbox, template/validator drift, generic, contradictory, fake browser-proof, ambiguous skipped-browser, owner/state-mismatched review notes, release packaging drift, and architecture-boundary drift |
| Thinnest reliable proof before browser tests      | Testing policy, terminal guide, scripts, fast command lanes in `docs/PRODUCT-VALIDATION-OBJECTIVES.md`, current audit evidence, `tests/harness/product-validation-objectives.test.ts`, `tests/harness/build-release.test.ts`, `tests/harness/verify-electron-package.test.ts`, and `npm run test:validation-guards` support owner-local proof before Playwright. | Documented and checked for script/test-path drift                                                                                                                                                                                                      |
| Reserve expensive browser tests for browser risks | Browser canary/terminal scripts are scoped; docs, `.github/PULL_REQUEST_TEMPLATE.md`, `scripts/validate-pr-description.mjs`, and `npm run validate:pr-description` require browser lanes run or intentionally skipped with a reason.                                                                                                                             | Guardrail rejects node-only proof as browser proof                                                                                                                                                                                                     |

## Remaining Gaps

1. The goal is broader than the current changed files. It cannot be marked complete from docs,
   targeted tests, or architecture evidence alone.
2. Desktop-class responsiveness is now measured by the smoke scorecard. The latest repeat baseline
   exposed selected-terminal cold launch and renderer-tier misses. A follow-up product-code
   experiment that prebinds the browser output channel during lazy terminal-session module loading
   passed every smoke budget again after final review fixes, the cleanup scorecard addition, a
   narrow reconnect/replay lane, a narrow remote/mobile command-session lane, and the takeover
   prompt cleanup fix.

   The latest three-run artifact
   `artifacts/performance-scorecard/smoke/summary-2026-05-09T20-16-23-478Z.md` passed every smoke
   budget. Treat that as promising selected-terminal startup, current-branch cleanup, reconnect
   selected-surface, remote takeover, and remote command acknowledgement evidence, not full
   product-goal proof.

   A loaded no-rebuild rerun also showed unrelated startup and preview spans regressing together,
   so browser timing must remain load-sensitive evidence rather than the only iteration loop. A
   separate loaded terminal UI-fluidity run completed, but it exposed multi-visible terminal
   round-trip and frame-gap misses rather than proving the desktop-class load goal. The current
   evidence still does not prove reconnect under heavier replay/load, managed-worktree cleanup,
   long-lived multi-client coordination, or loaded full-scorecard behavior.

3. Review notes now have a pull request template prompt and CI check that rejects missing,
   misplaced, unknown-checkbox, template/validator drift, generic, contradictory,
   fake browser-proof, ambiguous skipped-browser, or owner/state-mismatched entries, but reviewers
   still need to judge whether the stated product pain, owner, proof, and browser rationale are
   correct.
4. Browser proof remains deliberately selective. Any change that touches real focus, paint,
   navigation, cookies, browser-side websocket bootstrap, or multi-context coordination still needs
   targeted Playwright coverage.

## Known Weak Proof Areas

These are not blockers for the current docs and review-guard changes. They are proof gaps that must
close before the broader product objective can be called complete.

### Different-width resize authority

A terminal can look ready while resize ownership or geometry authority is stale, which breaks
desktop-like terminal confidence.

Current source of truth: `server/session-stress.test.ts` covers accepted/rejected resize authority
across handoff churn; `src/components/terminal-view/terminal-input-pipeline.test.ts` covers latest
peer-controlled geometry flush after takeover and after peer control clears to unowned.

Needed proof direction: owner-local proof exists for the resize authority contract. Add browser-lab
coverage when real browser viewport geometry, focus, paint, or multi-context resize coordination
changes.

### Attach-priority scheduler budget

Selected-surface-first startup depends on attach priority staying bounded under background work.

Current source of truth: `src/app/terminal-attach-scheduler.test.ts` proves foreground
serialization, the two-slot background attach budget, and selected/foreground attach admission even
when background attach work has saturated that budget.

Needed proof direction: owner-local budget proof exists. Add browser proof only when
attach-priority changes affect real focus, paint, hidden-tab behavior, or startup timing.

### Loaded multi-agent terminal fluidity

The product goal says many active agents should still feel desktop-like; smoke scorecard success
without load is not enough.

Current source of truth:

- `artifacts/terminal-ui-fluidity/2026-05-09T20-18-14-789Z/summary.md` completed the 24-terminal
  `product_default` vs `high_load_mode_product` matrix across 1, 2, and 4 visible terminals.
  Applying current provisional observations to that artifact yields 60 budget misses across 90
  measured checks.
- The same artifact found weak product behavior: `product_default` had `interactive_verbose` p95
  round trips of 1825.20ms and 1868.30ms at 2 and 4 visible terminals, while
  `high_load_mode_product` had 1-visible `recent_hidden_switch` frame-gap p95 316.70ms, round trip
  1973.50ms, render p95 15728.90ms, and hidden queue p95 15006.00ms.
- The 2026-05-10 sparse hidden-switch fix now has targeted browser evidence:
  `artifacts/terminal-ui-fluidity/2026-05-10-high-load-hidden-switch-echo-check/summary.md`
  improved that lane to frame-gap p95 100.10ms, long-task total 1680ms, hidden-switch round trip
  553.40ms, terminal render p95 1943.80ms, focused queue p95 136.40ms, and hidden queue p95 0ms
  after preserving hidden hibernation and adding sparse switch echo protection.
- A later 2026-05-10 2-visible pressure pass improved but did not close the next loaded
  `interactive_verbose` lane. Before the retained pressure change,
  `artifacts/terminal-ui-fluidity/2026-05-10-high-load-interactive-verbose-mini/summary.md` showed
  2-visible frame-gap p95 283.30ms, long-task total 3990ms, terminal render p95 5471.40ms, and
  focused round trip 1773.40ms. The retained pressure check at
  `artifacts/terminal-ui-fluidity/2026-05-10-high-load-interactive-verbose-pressure-check/summary.md`
  moved 2-visible to frame-gap p95 100.10ms, long-task total 3732ms, terminal render p95
  4670.70ms, and focused round trip 733.80ms. A direct non-target visible candidate-limit
  experiment was rejected because it worsened 4-visible behavior.
- A direct sustained-input coalescing experiment was also rejected:
  `artifacts/terminal-ui-fluidity/2026-05-10-input-coalescing-check/summary.md` regressed
  2-visible `interactive_verbose` to frame-gap p95 649.90ms, long-task total 9754ms, terminal
  render p95 7273.90ms, and focused round trip 4291.40ms. The per-run split showed input sent p95
  2669.90ms, so the batching shape moved pressure into the send acknowledgement path instead of
  improving visible echo.
- A follow-up harness check found that requested visible-terminal labels could drift from the
  app-reported visible-terminal count after viewport settling. The profiler now aligns the viewport
  to the requested app-reported visible count or fails the run. The aligned High Load Mode evidence
  is materially sharper:
  `artifacts/terminal-ui-fluidity/2026-05-10-visible-count-alignment-check/summary.md` confirmed an
  actual 2-visible layout with frame-gap p95 116.60ms, long-task total 3269ms, focused round trip
  645.70ms, terminal render p95 2368.10ms, input buffered p95 80.40ms, input sent p95 386.60ms, and
  hidden queue p95 0ms; `artifacts/terminal-ui-fluidity/2026-05-10-visible-count-alignment-check-visible4/summary.md`
  confirmed an actual 4-visible layout with frame-gap p95 116.70ms, long-task total 3016ms,
  focused round trip 632.60ms, terminal render p95 4193.50ms, input buffered p95 104.50ms, input
  sent p95 338.40ms, and hidden queue p95 0ms.
- The next diagnostics pass split focused round-trip probes into keyboard input dispatch and
  echo-after-dispatch timing. In
  `artifacts/terminal-ui-fluidity/2026-05-10-focused-roundtrip-split-repeat3/`, the exact
  2-visible `interactive_verbose` repeats showed one clean round-trip pass, one timeout, and one
  slow echo-after-dispatch sample. That led to a reporting fix: matrix aggregation now sums timeout
  counts, filters negative timeout sentinels out of latency medians, and gate observations fail
  explicit focused-roundtrip timeouts instead of letting repeated runs hide them.
- A targeted Chromium trace at
  `artifacts/terminal-ui-fluidity/2026-05-10-interactive-verbose-trace-check/` kept the same exact
  2-visible lane and pointed the long-task tail at browser commit work rather than app scheduler
  bookkeeping. Runtime owner p95 was 0.50ms, scheduler drain p95 was 0.40ms, and the trace summary
  was dominated by `Commit` slices.
- A direct focused-pressure-neutral simplification was rejected:
  `artifacts/terminal-ui-fluidity/2026-05-10-focused-pressure-neutral-check/summary.md` improved
  long-task total to 2695ms but regressed the product-visible path: frame-gap p95 216.70ms,
  focused round trip p95 1152.80ms, terminal render p95 3110.40ms, input sent p95 612.70ms, and
  flow-control paused eight times with zero resumes. The focused pressure boost should stay in
  place while the next pass targets acknowledgement, flow-control resume, and rendered commit cost.
- The fresh retained loaded matrix at
  `artifacts/terminal-ui-fluidity/2026-05-10-retained-loaded-matrix-repeat3/summary.md` failed 21
  of 51 provisional checks across `recent_hidden_switch`, `interactive_verbose`, and `bulk_text`.
  It confirmed that the remaining loaded gap is broader than the earlier narrow checks: 2-visible
  `interactive_verbose` still missed focused round trip at 642.40ms and long-task total at 4522ms,
  4-visible `recent_hidden_switch` missed focused round trip at 2091.10ms, and bulk text still
  missed frame, long-task, and render budgets at 2 and 4 visible terminals.
- Two follow-up candidates were rejected and backed out. Trace-backed/gated focused-echo completion
  worsened the 2-visible `interactive_verbose` path
  (`2026-05-10-trace-backed-echo-completion-check` and
  `2026-05-10-gated-trace-echo-completion-check`), and a 4KiB interactive-echo write-slice cap had
  one good repeat but a worse tail
  (`2026-05-10-interactive-echo-write-slice-check`: frame-gap p95 316.70ms, long-task total
  5953ms, focused round trip 3694.80ms).
- The input acknowledgement diagnostics now split buffered-to-dispatched and dispatched-to-accepted
  timing. The narrow smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-input-ack-split-smoke/summary.md` verified the split in
  real browser output: 2-visible `interactive_verbose` had frame-gap p95 83.40ms, long-task total
  2575ms, focused round trip 524.50ms, input dispatched p95 118.30ms, and input accepted p95
  167.90ms. This is diagnostic validation, not loaded-goal completion.
- The repeated split run at
  `artifacts/terminal-ui-fluidity/2026-05-10-input-ack-split-repeat3/summary.md` showed the bad
  tail spans multiple stages. 2-visible `interactive_verbose` still failed frame-gap p95 at
  183.30ms, long tasks at 5924ms, terminal render p95 at 6216.10ms, and focused round trip at
  1065.30ms, with input-dispatch p95 384.10ms, echo-after-dispatch p95 737.80ms, terminal-input
  dispatched p95 361.10ms, and accepted p95 324.50ms.
- A narrower in-flight interactive batching experiment was rejected and backed out. The aggregate
  artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-in-flight-interactive-batch-check/summary.md` still
  failed frame-gap, long-task, and focused-roundtrip budgets, and repeat 2 exposed the tail more
  clearly: focused round trip 4505.40ms, input-dispatch p95 1765.40ms, and echo-after-dispatch p95
  2740.00ms. Do not treat interactive input batching behind an in-flight send as a retained product
  direction.
- The backend input trace is now emitted in UI-fluidity profiler and matrix artifacts. The smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-backend-input-trace-smoke/summary.md` still failed the
  loaded 2-visible `interactive_verbose` frame and focused-roundtrip budgets, but narrowed the owner
  split: server queue p95 was 0.25ms, PTY input max queue was one char, control
  backpressure/send errors were zero, transport residual p95 was 209.75ms, backend-observed render
  p95 was 234.90ms, and terminal render p95 was 3743.80ms. This weakens PTY write/queue policy as
  the next target and points back to rendered terminal commit pressure, output priority during
  focused input, or transport-to-render residual.
- A direct High Load Mode focused-preemption-window experiment was rejected and backed out. The
  repeated artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-high-load-focused-preemption-400-check/summary.md`
  showed that widening the focused preemption window from 150ms to 400ms regressed the 2-visible
  `interactive_verbose` lane: frame-gap p95 200.00ms, long-task total 5982ms, terminal render p95
  5857.10ms, and focused round trip 928.20ms. Do not pursue broad preemption-window widening
  without a narrower diagnostic.
- Terminal visible-line diagnostics are now opt-in outside browser render/restore harnesses. The
  repeated artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-visible-line-diagnostics-opt-in-check/summary.md`
  reduced terminal-render p95 to 1260.50ms, but still failed long-task total at 5639ms and focused
  round trip at 633.70ms. This is retained measurement-fidelity work, not loaded-goal completion.
- Focused-input output priority is now split in profiler and matrix summaries. The smoke artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-focused-input-output-split-smoke/summary.md` reported
  focused-input focused bytes p95 6463, active-visible bytes p95 0, visible-background bytes p95
  64, direct calls p95 0, queued calls p95 2, visible-background queue age p95 154.40ms, and queued
  queue age p95 154.40ms. This narrows the next product-code search away from broad active-visible
  or direct-write suppression during focused input and toward keyboard dispatch, acknowledgement,
  transport-to-render split quality, and browser commit cost.
- Backend input traces now split matched echo timing into PTY echo, backend output buffer, and
  browser delivery. The loaded smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-backend-output-split-final-smoke/summary.md` still failed
  the 2-visible `interactive_verbose` provisional budgets with frame-gap p95 250.00ms, long-task
  total 3174ms, focused round trip 911.60ms, and terminal render p95 2708.50ms. The new split makes
  the useful negative evidence sharper: server queue p95 was 0.20ms, PTY echo p95 was 92.51ms,
  backend output buffer p95 was 0.03ms, and browser delivery p95 was 66.46ms, while client-send p95
  was 288.90ms, renderer-observed render p95 was 497.10ms, focused round-trip split was 165.00ms
  input-dispatch plus 746.60ms echo-after-dispatch, and visible-background queue age during focused
  input was 2460.90ms. Do not treat PTY queue/write or backend output buffering as the primary next
  target for this lane without new evidence.
- A narrow visible-background suppression guard is retained as partial product-code progress, not
  as loaded-goal completion. The scheduler now blocks new visible-background drains after focused
  echo completion while typing-critical input remains active, with direct owner-local coverage for
  that invariant. The single smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-typing-critical-visible-background-block-smoke/summary.md`
  passed the loaded 2-visible `interactive_verbose` budgets: frame-gap p95 133.30ms, long-task
  total 2979ms, focused round trip 416.90ms, and focused-input visible-background bytes p95 0. The
  repeat confirmation at
  `artifacts/terminal-ui-fluidity/2026-05-10-typing-critical-visible-background-block-repeat3/summary.md`
  still failed long-task and focused-roundtrip budgets, with long tasks at 3115ms, focused round
  trip at 754.80ms, and a repeat-2 outlier showing visible-background queue age 4512.40ms during
  focused input. This confirms the guard is useful but insufficient: the next bottleneck is
  in-flight visible-background writes, browser commit pressure, and client dispatch/echo
  coordination under load.
- Terminal write-duration diagnostics are now emitted in UI-fluidity profiler and matrix artifacts.
  The first narrow smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-terminal-write-duration-diagnostic-smoke/summary.md`
  verified the split in real browser output but still failed the loaded 2-visible
  `interactive_verbose` budgets: long tasks were 4014ms and focused round trip was 997.30ms. The
  diagnostic is useful because it narrows this sample away from visible-background writes inside the
  focused-input window: total write-duration p95 was 168.80ms and visible-background write-duration
  p95 was 89.80ms overall, but focused-input visible-background bytes and focused-input
  visible-background write-duration were both 0. The remaining split in this sample points to input
  dispatch p95 549.20ms, accepted p95 347.80ms, browser delivery p95 237.08ms, and focused
  write-duration p95 75.40ms during focused input.
- A narrower 2-visible visible-background write-slice experiment was rejected and backed out. The
  first 512B smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-few-visible-background-write-512-smoke/summary.md`
  reduced some single-run dispatch/write metrics but still missed long-task and focused-roundtrip
  budgets. The three-repeat confirmation at
  `artifacts/terminal-ui-fluidity/2026-05-10-few-visible-background-write-512-repeat3/summary.md`
  failed with long tasks at 4458ms and focused round trip at 673.10ms, while focused-input
  visible-background writes reappeared at 512B with focused-input visible-background write-duration
  p95 221.10ms. Keep the retained 1024B critical slice until a more precise diagnostic proves a
  smaller slice helps browser commit pressure without increasing focused-input write churn.
- Active terminal writes are now sampled per frame in the UI-fluidity diagnostics. This is retained
  as measurement fidelity: completion-duration summaries can miss writes that start before focused
  input and remain pending during it, so the next loaded artifact can distinguish in-flight terminal
  write pressure from writes that completed during the focused-input window.
- The active-write smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-active-write-diagnostic-smoke/summary.md` confirmed
  that distinction in the loaded 2-visible `interactive_verbose` lane: focused-input
  visible-background bytes were 0, but focused-input active visible-background write age was
  448.10ms p95, while the lane still failed long-task and focused-roundtrip budgets. A broad
  typing-critical-window experiment was rejected and backed out:
  `artifacts/terminal-ui-fluidity/2026-05-10-typing-critical-900-smoke/summary.md` worsened
  frame-gap p95 to 283.40ms, long tasks to 6712ms, terminal render p95 to 5724.90ms, and focused
  round trip to 2337.80ms with flow-control pauses. Do not stretch global typing-critical state as
  the next fix.
- A scheduler-only visible-background in-flight admission guard was rejected and backed out. The
  single smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-visible-background-inflight-limit-smoke/summary.md`
  reduced focused round trip to 487.10ms and focused-input active visible-background write age to
  0, but still missed long tasks at 3137ms. The repeated artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-visible-background-inflight-limit-repeat3/summary.md`
  failed with long tasks at 3178ms, one focused-roundtrip timeout, and focused round trip p95
  526.25ms; repeat 2 had frame-gap p95 499.90ms, long tasks 10727ms, and a round-trip timeout. The
  aggregate still showed focused-input active write count p95 2 and active visible-background write
  age p95 137.30ms. This rules out a pure scheduler admission guard as the next retained fix unless
  a later design also accounts for direct/queued write admission and browser commit pressure.
- An early local-input intent experiment was rejected and backed out. Moving the typing-critical
  marker to xterm non-paste input receipt passed the first smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-early-input-intent-smoke/summary.md` with frame-gap p95
  100.00ms, long tasks 2457ms, and focused round trip 463.10ms, but focused-input
  visible-background bytes still reached p95 1024 and active visible-background write age reached
  p95 182.70ms. The repeat artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-early-input-intent-repeat3/summary.md` failed with
  long tasks 3272ms and focused round trip 538.50ms; repeat 2 had frame-gap p95 266.60ms, long
  tasks 4869ms, and focused round trip 2095.20ms. This rules out an earlier marker alone as the next
  retained fix.
- A passive-visible render hibernation experiment was rejected and backed out. The experiment
  temporarily hibernated non-focused visible sibling renderers during High Load Mode focused input
  while keeping the selected/focused terminal live. The repeat artifact at
  `artifacts/terminal-ui-fluidity/2026-05-10-passive-visible-hibernate-smoke/summary.md` reduced
  focused-input visible-background bytes to 0 in aggregate and improved focused round trip versus
  the earlier retained repeat, but still failed with long tasks at 4317ms and focused round trip
  p95 554.80ms; repeat 2 had frame-gap p95 266.70ms and focused round trip 1733.90ms. Suppressed
  visible output also rose to 1721808 bytes, so this is not a clean product tradeoff.
- Input dispatch diagnostics now split task-command lease wait from buffered-to-dispatched and
  dispatched-to-accepted timing. This is retained measurement fidelity for the next product-code
  decision: if `terminal-input-split lease-wait-p95` is high in the next loaded artifact, the next
  fix should target task-command ownership/control transport; if it is low, the remaining tail is
  later browser delivery, focused write, or render commit work.
- The first lease-wait browser smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-input-lease-wait-diagnostic-smoke/summary.md` rules out
  task-command lease acquisition as the next bottleneck for the loaded 2-visible
  `interactive_verbose` sample. The lane still failed with frame-gap p95 183.40ms, long tasks
  7063ms, terminal render p95 5474.20ms, and focused round trip 1074.80ms, but lease-wait p95 was
  only 0.10ms and max was 1.50ms. The larger remaining numbers were dispatched p95 241.70ms,
  accepted p95 348.30ms, browser delivery p95 243.39ms, focused-input write-duration p95 318.00ms,
  and focused-input active visible-background write age p95 386.10ms.
- A follow-up active-write diagnostic now splits focused-input visible-background active writes into
  writes that started before the focused-input window and writes that started during it. The first
  browser smoke with the split at
  `artifacts/terminal-ui-fluidity/2026-05-10-active-write-start-boundary-smoke/summary.md` still
  failed the loaded 2-visible `interactive_verbose` long-task budget at 4399ms, but it confirmed
  the split in real artifact output: focused-input visible-background active write p95 was one write
  at 183.10ms that started before focused input, while started-during-input visible-background
  active writes were 0. That does not claim a performance win; it points the next experiment toward
  pre-existing in-flight browser commit pressure rather than new visible-background write admission
  during typing-critical input in this sample.
- A direct visible-background continuation-delay experiment was rejected and backed out. The
  experiment inserted a 16ms delay before continuing visible-background writes under High Load Mode
  frame pressure. In
  `artifacts/terminal-ui-fluidity/2026-05-10-visible-background-continuation-delay-smoke/summary.md`,
  the same loaded 2-visible `interactive_verbose` lane regressed: long tasks rose to 5067ms,
  focused round trip missed at 608.80ms, terminal render p95 rose to 2017.40ms, and the
  pre-existing visible-background active write age grew to 287.40ms while started-during-input
  active writes remained 0. Do not revive a fixed continuation delay unless a sharper design proves
  it reduces browser commit pressure without aging already-active writes.
- The active-write start-boundary diagnostic now also reports active-write bytes for writes that
  started before or during focused input. The rebuilt smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-active-write-byte-split-smoke-rebuilt/summary.md`
  still failed the loaded 2-visible `interactive_verbose` lane with long tasks at 4679ms and
  focused round trip at 704.40ms, but it showed the focused-input visible-background active write
  that started before input was only 556B and aged to 130.30ms; started-during-input
  visible-background active writes were 0B/0 writes. Backend splits stayed comparatively cheap
  (server queue p95 0.12ms, PTY echo p95 31.75ms, backend output buffer p95 0.03ms, browser delivery
  p95 22.95ms), while input sent p95 was 314.50ms and accepted p95 was 279.40ms. This points away
  from another write-size cap alone and toward small-write callback/commit aging plus input
  dispatch/acknowledgement under browser pressure.
- Browser-control diagnostics now record websocket `bufferedAmount` high-water in profiler and
  matrix summaries. The rebuilt smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-browser-control-buffered-smoke/summary.md` failed the
  same loaded 2-visible `interactive_verbose` lane with frame-gap p95 300.00ms, long tasks 9409ms,
  terminal render p95 8114.80ms, and focused round trip 1996.30ms, but `control-buffered-max` was
  0 with zero control backpressure, not-open, send-error, delayed-depth, or delayed-bytes. Treat this
  as negative evidence against hidden browser-control websocket bufferedAmount pressure as the next
  target for this sample; the remaining tail still points to client dispatch, browser delivery,
  rendered terminal commit work, and small in-flight visible-background write aging under browser
  pressure.
- Renderer input queue saturation is now visible in profiler and matrix summaries. The raw
  browser-control-buffered artifact showed `inFlightBatchesMax=16` and `queuedChunksMax=39`, so a
  direct interactive/control in-flight cap increase was tried and backed out. In
  `artifacts/terminal-ui-fluidity/2026-05-10-interactive-input-concurrency-check/summary.md`, the
  experiment proved the local dispatch hypothesis (`dispatched-p95=0.20ms`, `client-send-p95=0.20ms`,
  `renderer-terminal-input in-flight-max=39`) but not the product goal: the lane still failed
  frame-gap p95 183.40ms, long tasks 6698ms, terminal render p95 5492.90ms, and focused round trip
  2061.20ms. Do not raise the interactive in-flight cap alone; it shifts the tail to
  echo-after-dispatch, PTY echo, browser delivery, and rendered commit pressure without closing
  user-visible round trip.
- Browser-client control send buffering is now split from backend control buffering. The narrow
  smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-browser-client-buffered-smoke/summary.md` still failed
  the loaded 2-visible `interactive_verbose` long-task budget at 4716ms, but frame-gap p95 was
  83.40ms, focused round trip p95 was 473.90ms, and terminal render p95 was 963.90ms. The new
  client-side signal recorded `browser-control-client sends=216`,
  `nonzero-buffered-sends=112`, and `buffered-max=7298`, while backend `control-buffered-max`
  remained 0. This keeps browser-client command pacing/priority in scope for the next experiment,
  but it does not justify a broad concurrency increase because that shape was already rejected.
- The by-type browser-client buffering smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-browser-client-buffered-by-type-smoke/summary.md`
  reproduced the bad loaded tail and made the client-side pressure split more precise: frame-gap
  p95 was 233.30ms, long tasks were 6929ms, terminal render p95 was 6793.50ms, and focused round
  trip was 1224.30ms. The buffered client sends were concentrated in input and resume traffic
  (`input-sends=78`, `input-nonzero-buffered=32`, `input-buffered-max=7295`,
  `resume-sends=24`, `resume-nonzero-buffered=22`, `resume-buffered-max=7171`), while resize sends
  stayed at 0 and backend `control-buffered-max` stayed 0. That points the next product-code search
  at input/resume pacing and flow-control recovery, not resize handling or server-side
  browser-control buffering.
- Two flow-control low-watermark experiments were rejected and backed out. Raising `FLOW_LOW` from
  32KiB to 128KiB in
  `artifacts/terminal-ui-fluidity/2026-05-10-flow-low-128-smoke/summary.md` improved some
  single-run visible metrics, including focused round trip at 499.50ms and terminal render p95 at
  882.50ms, but still failed long tasks at 5652ms and produced heavy resume churn
  (`resume-sends=60`, `resume-nonzero-buffered=30`). A 64KiB smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-flow-low-64-smoke/summary.md` also failed with long
  tasks at 4301ms and focused round trip at 615.40ms. The product decision is to keep the original
  32KiB low watermark until a narrower resume-pacing design proves both acknowledgement and browser
  commit improvement without churn or stale-output tradeoffs.
- A duplicate flow-control resume settle-window experiment was also rejected and backed out. The
  experiment briefly kept a locally sent resume request pending so repeated input/idle recovery
  would not spam duplicate resumes while the browser/server path caught up. In
  `artifacts/terminal-ui-fluidity/2026-05-10-flow-resume-settle-smoke/summary.md`, resume sends
  dropped to 5 and nonzero-buffered resume sends dropped to 0, but the lane still failed with long
  tasks at 4287ms and focused round trip at 672.90ms. Resume-chatter reduction alone is not a
  retained product win; the next flow-control attempt should target explicit backend
  acknowledgement or priority, rather than duplicate-resume coalescing alone.
- An explicit backend-acknowledged flow-control pause/resume experiment was rejected and backed
  out. It made browser flow-control pause/resume request-tracked and waited for
  `agent-command-result`; the owner-local protocol, IPC, server websocket, and command-result tests
  passed, but
  `artifacts/terminal-ui-fluidity/2026-05-10-flow-control-ack-smoke/summary.md` regressed the
  loaded 2-visible `interactive_verbose` lane to frame-gap p95 300.00ms, long tasks 5143ms,
  terminal render p95 6682.20ms, focused round trip p95 1973.90ms, input sent p95 1082.70ms, and
  accepted p95 931.10ms, with eight pauses and zero resumes. Do not request-track flow-control
  pause/resume on the hot path by itself; it worsens the visible lane and does not close the
  acknowledgement/render tail.
- A focused-input flow-control recovery-window experiment was rejected and backed out. It kept
  pause/resume untracked and allowed a short resume escape hatch for a paused focused channel when
  interactive input arrived with an idle queue but high watermark. In
  `artifacts/terminal-ui-fluidity/2026-05-10-focused-input-flow-recovery-smoke/summary.md`, resume
  sends rose to 16, but the loaded lane still missed: frame-gap p95 283.40ms, long tasks 5344ms,
  terminal render p95 5274.80ms, and focused round trip p95 590.00ms. Resume-count improvement by
  itself is not a product win; do not revive an input-coupled resume escape hatch unless it also
  reduces browser commit pressure and focused echo latency.
- A browser `isInputPending` visible-background admission guard was rejected and backed out. It
  deferred 2-visible High Load Mode visible-background drains while Chromium reported pending input.
  In
  `artifacts/terminal-ui-fluidity/2026-05-10-pending-input-visible-background-guard-smoke/summary.md`,
  frame-gap p95 passed at 116.70ms, but long tasks rose to 7183ms and focused round trip missed at
  876.00ms. The artifact still showed a pre-existing 1024B visible-background write aging to
  276.80ms during focused input, with input dispatched p95 486.70ms and accepted p95 535.10ms. Do
  not use a browser-input-pending visible-background guard by itself; it does not solve already-active
  commit pressure or input acknowledgement.
- Terminal command-result acknowledgement is now split on both sides of the browser/server boundary.
  The smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-command-result-ack-split-smoke/summary.md` verified the
  new artifact fields: renderer command-result p95 was 286.10ms, accepted-settle p95 was 0ms,
  backend command-ack p95 was 0.21ms, PTY-write-to-command-ack p95 was 0.09ms, browser delivery p95
  was 129.62ms, and client-send p95 was 233.60ms. The lane still missed focused round trip at
  604.40ms, so this is retained measurement fidelity rather than loaded-goal completion. The useful
  conclusion is that backend command-result generation and renderer promise settlement are weak next
  targets; browser-client send/buffering, browser delivery, and rendered commit pressure remain in
  scope.
- Browser-client send diagnostics now also split synchronous websocket send duration from post-send
  buffering, by message type. The smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-browser-client-send-duration-smoke/summary.md` verified
  the new artifact fields but still missed the loaded lane with long tasks at 3287ms and focused
  round trip at 762.80ms. The evidence rules out local JSON/stringify/socket-send duration as the
  main culprit: overall, input, and resume send-duration p95 were all 0.10ms. The same artifact
  still showed browser-client buffering and downstream pressure: post-send buffered max was 6226
  bytes, input post-send buffered max was 6226 bytes, resume post-send buffered max was 5871 bytes,
  browser delivery p95 was 331.42ms, and backend browser-control buffered max remained 0. This keeps
  browser-client pacing/priority, browser delivery, flow-control resume churn, and rendered commit
  pressure in scope, but not synchronous renderer send duration.
- Browser delivery diagnostics now split backend-to-terminal-handler delivery into browser transport
  delivery and channel dispatch. The smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-browser-transport-receive-split-smoke/summary.md`
  verified the new fields but still missed focused round trip at 867.10ms, with terminal render p95
  at 2828.10ms. The split rules out terminal-session channel dispatch overhead as the next primary
  target: browser delivery p95 was 248.43ms, browser transport delivery p95 was also 248.43ms, and
  browser channel dispatch p95 was only 0.10ms. This points the next pass at browser event-loop
  delivery before the channel callback, input dispatch under browser pressure, flow-control pacing,
  and rendered commit pressure.
- Focused round-trip probes now also distinguish terminal-handler receipt from rendered echo
  completion. The smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-focused-rendered-probe-split-smoke/summary.md` verified
  the rendered fields and still missed the loaded lane: focused round trip was 512.10ms, rendered
  round trip was 596.30ms, render-after-receive was 84.20ms, frame-gap p95 was 83.40ms, long tasks
  were 2355ms, and terminal render p95 was 650.20ms. The useful negative evidence is that browser
  channel dispatch was 0ms, backend server/PTY/output buffering stayed cheap, and synchronous
  client send duration stayed tiny; the remaining product-code search should stay on keyboard
  dispatch under browser pressure, browser transport delivery, input/resume pacing, and small
  rendered-write/commit cost rather than terminal-session dispatch or backend queue rewrites.
- A hot-typing untracked resume guard was rejected and backed out. It stopped
  `armInteractiveEchoFastPath()` from sending idle `ResumeAgent` recovery messages unless the
  pipeline had locally paused flow control. The browser smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-hot-typing-untracked-resume-guard-smoke/summary.md`
  proved resume sends dropped to 0, but the lane got worse: pause sends rose to 8, frame-gap p95 was
  283.30ms, long tasks were 4456ms, terminal render p95 was 4171.20ms, focused round trip was
  1337.30ms, rendered round trip was 1847.30ms, input sent p95 was 748.40ms, and accepted p95 was
  431.50ms. Do not suppress hot-path untracked resumes alone; the evidence says that creates
  pause-heavy stale-output behavior instead of improving input/echo latency.
- Terminal write diagnostics now split xterm write duration from synchronous callback
  finalization. The browser smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-finish-write-finalization-split-smoke/summary.md`
  verified the fields without changing runtime policy. It still missed the loaded frame/long-task
  lane, but focused round trip stayed much better than the rejected resume guard: frame-gap p95 was
  100.00ms, long tasks were 2566ms, focused round trip was 417.50ms, rendered round trip was
  493.10ms, render-after-receive was 75.60ms, and terminal render p95 was 2574.20ms. The split rules
  out callback bookkeeping as the primary next target: write duration p95 was 196.90ms, while
  write-finalization p95 was 1.00ms overall and 2.80ms during focused-input frames. Keep the next
  product-code search on xterm/terminal-render pressure, browser event-loop delivery, input dispatch,
  and input/resume pacing rather than finish-write bookkeeping rewrites.
- Terminal write diagnostics now also split write shape into `plain`, `control`, and
  `redraw-control`. The browser smoke at
  `artifacts/terminal-ui-fluidity/2026-05-10-write-shape-split-smoke/summary.md` verified the
  fields and narrowed the current loaded 2-visible `interactive_verbose` sample to redraw-heavy
  terminal traffic: frame-gap p95 was 83.40ms, long tasks were 2707ms, focused round trip was
  491.90ms, rendered round trip was 701.40ms, render-after-receive was 209.50ms, and terminal render
  p95 was 1069.50ms. Per-frame write-duration p95 was entirely `redraw-control`: plain/control
  bytes were 0, redraw-control bytes p95 was 7245, and redraw-control write-duration p95 was
  141.00ms; during focused-input frames, redraw-control bytes p95 stayed 7245 with 71.00ms
  redraw-control write-duration p95. Finalization stayed tiny at 1.20ms overall and 1.50ms during
  focused-input frames. This makes generic plain-output writes and callback finalization weak next
  targets; the next product-code search should explain and reduce redraw-control terminal
  write/commit pressure without increasing stale visible output or input/resume churn.
- A follow-up artifact review found and fixed a diagnostic attribution bug in that split: overlapping
  write completions could be assigned using a stale last-completed shape. Active writes now use FIFO
  attribution, and
  `artifacts/terminal-ui-fluidity/2026-05-10-write-shape-fifo-smoke/summary.md` verified exact
  call/duration count alignment by shape. The corrected run still failed the product lane with
  frame-gap p95 100.10ms, long tasks 3309ms, focused round trip 562.40ms, terminal render p95
  477.70ms, per-frame `redraw-control` write-duration p95 185.60ms, and focused-input
  `redraw-control` write-duration p95 93.80ms.
- A product-code experiment that shortened focused redraw coalescing during interactive echo from
  16ms to 8ms was rejected after
  `artifacts/terminal-ui-fluidity/2026-05-10-focused-input-redraw-coalesce-8-smoke/summary.md`:
  frame-gap p95 and write-duration counters improved, but long tasks regressed to 4478ms, focused
  round trip to 678.20ms, input dispatch p95 to 390.80ms, and terminal render p95 to 957.90ms. Do
  not repeat focused-input-only redraw coalescing cuts without a diagnostic that explains those
  regressions.
- A stricter statusline redraw-supersession experiment was also rejected and backed out after
  `artifacts/terminal-ui-fluidity/2026-05-10-redraw-supersession-smoke/summary.md`: write calls
  dropped, but frame-gap p95 regressed to 299.90ms, long tasks to 5304ms, focused round trip to
  2807.20ms, terminal render p95 to 5878.10ms, browser delivery p95 to 608.39ms, and
  `redraw-control` write-duration p95 to 466.30ms. It also created write-shape attribution
  mismatch under the candidate, so renderer-side lossy redraw supersession should not be retried
  without lower-level proof.

Needed proof direction: treat this as a retained fix for the slowest measured hidden-switch lane,
not as loaded-goal completion. The next product-code target is cross-layer acknowledgement and
backpressure under loaded browser commit pressure. Use the input-buffer/input-send/flow-control/
render split and aligned visible-count harness to avoid repeating disproven batching or
output-scheduling shapes.

The evidence now points to keyboard dispatch under load, command acknowledgement,
input/PTY/write-ack, browser transport delivery, flow-control pause/resume windows, focused echo
measurement semantics, render-after-receive cost, redraw-control terminal write/commit pressure,
and sampled in-flight visible-background writes when they overlap focused input.

Do not prioritize server-side browser-control bufferedAmount tuning, synchronous renderer send
duration, terminal channel-dispatch rewrites, backend output buffering, finish-write bookkeeping
rewrites, generic plain-output writes, PTY queue/write rewrites, or hot-path untracked resume
suppression for this lane without new contrary evidence, and do not raise the interactive input
in-flight cap alone. For long-task work, prioritize redraw-control terminal write pressure,
browser-client command pacing, flow-control priority, browser transport delivery, and browser commit
cost over store or scheduler-scan refactors. Rerun the smoke scorecard after the repeated loaded
matrix stops exposing new loaded regressions.

### Long-lived browser session reliability

Remote sessions, replay, and multi-client control need confidence over time, beyond startup or
single reconnect examples.

Current source of truth: `server/browser-control-plane.test.ts` covers repeated same-client
reconnect churn while preserving task ownership, presence freshness, final cleanup, stale
delayed-send / micro-batched control diagnostics reset guards, and owner-level cleanup of pending
batched/delayed send timers during shutdown; `tests/contracts/control-plane-stress.contract.test.ts`
covers many-client control fanout and slow-consumer isolation.

Needed proof direction: owner-local control-plane churn proof exists. Add browser or diagnostic
coverage when real browser runtime duration, multi-context UI coordination, preview/review/
supervision interaction, or heavy terminal replay is the risk.

### Browser auth/bootstrap/reconnect overlap

Browser-first correctness can fail when auth, cold bootstrap, reconnect restore, and
selected-surface policy interact.

Current source of truth: `server/browser-control-plane.test.ts` covers reconnect authentication with
control-event replay, fresh auth remote status, and authoritative bootstrap snapshots;
`src/runtime/browser-session.runtime.test.ts` covers reconnect restore invalidation clearing stale
startup mode and treating failed restore as cancellation rather than completion;
[ARCHITECTURE.md](./ARCHITECTURE.md) still calls startup, reconnect churn, restore overlap, and
multi-client browser behavior high-risk.

Needed proof direction: owner-local auth/bootstrap replay and restore-cancellation proof exists. Add
focused browser/runtime scenarios when changes cross browser-side websocket auth, cold bootstrap
timing, reconnect restore, selected-terminal readiness, or multi-context coordination.

## Current Next Step

Use the product scorecard and diagnostics in
[PRODUCT-PERFORMANCE-EXECUTION-PLAN.md](./PRODUCT-PERFORMANCE-EXECUTION-PLAN.md) as the optimization
loop. The smoke startup path has moved from "find the selected-terminal bottleneck" to "stabilize
and broaden the retained selected-terminal improvement." Terminal-session module loading is split
out in startup diagnostics, an immediate browser/server preload experiment was rejected, and the
retained browser output-channel prebind experiment improved selected-terminal startup in the
post-fix scorecard sample.

The smoke scorecard now also covers current-branch cleanup while review and preview-manager
surfaces are open, a reconnect request-to-selected-terminal-interactive sample, and a mobile remote
shell takeover plus command acknowledgement sample from `/remote` to backend `write_to_agent`
response with scrollback confirmation.

The loaded 24-terminal UI-fluidity matrix is the clearest next product-code target. The first
retained fix improved the worst sparse hidden-switch lane by preserving hidden-output suppression in
High Load Mode and adding sparse switch echo protection. The second retained fix improved the
2-visible `interactive_verbose` frame/render shape by applying 2-visible pressure response, but
focused round trip and long-task time still miss the provisional loaded budget. A sustained input
coalescing attempt was rejected because it regressed input send acknowledgement and focused round
trip.

The latest harness correction now verifies the actual app-reported visible-terminal count before
measuring. With exact 2- and 4-visible layouts, High Load Mode passes the narrow
frame/render/hidden-queue shape and misses mainly on focused round trip plus a small long-task tail.
The focused round-trip split and timeout-accounting fix make that miss more legible: repeated loaded
evidence must distinguish keyboard dispatch from echo-after-dispatch and must fail explicit
timeouts.

The repeated retained matrix has now failed 21 checks, so the next step is not another broad
output-scheduler constant tweak. The backend input trace smoke makes PTY queue/write policy look
weak as the immediate target, and the focused-input output split does not show active-visible or
direct-write pressure as the main focused-input thief. Isolate the remaining `interactive_verbose`
keyboard-dispatch, command acknowledgement, transport-to-render residual, browser transport
delivery, flow-control pause/resume, rendered commit pressure, browser-client command pacing, and
focused echo measurement bottleneck under browser commit pressure.

The browser-control bufferedAmount high-water smoke argues against tuning hidden control
websocket buffering as the next pass, the browser-client send-duration smoke argues against chasing
synchronous renderer send duration, the browser transport receive split argues against
terminal-session channel dispatch as the next target, and the interactive input in-flight cap smoke
argues against raising that cap alone. The rendered-probe split now also shows terminal-handler
receipt and rendered echo completion separately, keeping render-after-receive cost visible while
discouraging terminal-session dispatch rewrites. The hot-typing untracked resume guard was also
rejected because it turned resume chatter into pause-heavy stale-output pressure. Do not simplify
away the focused dense-pressure boost; the rejected neutral-pressure check reduced long-task total
but harmed frame and echo responsiveness. The write-shape split now shows the current measured write
duration is redraw-control heavy, and the FIFO attribution fix makes that evidence reliable. The
8ms focused-input redraw coalescing and strict redraw-supersession smokes both showed that lower
frame/write counters can still worsen long-task, input-dispatch, focused-round-trip, terminal-render,
or browser-delivery tails. The next retained experiment should target redraw-control terminal
write/commit pressure rather than generic plain-output handling, finish-write finalization, narrower
coalescing windows alone, or renderer-side lossy supersession. Also avoid trace-only echo
completion, in-flight interactive batching, fixed echo-window write caps, input-coupled flow-control
resume escape hatches, browser-input-pending visible-background admission guards, and broad
focused-preemption-window widening unless new diagnostics explain the tail. Keep review and CI
guardrails downstream of that product work; they should preserve measured runtime properties, not
substitute for them.

## Current Fast-Lane Evidence

These commands were run on 2026-05-08, with the pending transport/release, type-driven guard, broad
non-browser, startup/runtime bundle-split, and final simplification review evidence refreshed on
2026-05-09. They validate the cheapest relevant seams for the current audit. Real browser proof
stays reserved for browser-only risk; the review diff lifecycle, preview proxy, remote shell, task
deletion, and terminal startup canaries were run only where the changed owner crossed browser-only
rendering, navigation, auth/bootstrap, cookie, or multi-context behavior.

| Surface                                    | Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review discipline                          | `npm run test:validation-guards`; `npm run test:architecture-guards`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Current guard lanes passed: validation 5 files, 50 tests; architecture 9 files, 41 tests                                                                                                                                                                                                                                                                                                                                                 |
| Static quality gates                       | `npm run check`; `git diff --check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed, including app, lifecycle, and server no-emit typecheck; CI static quality now delegates to the same `npm run check` lane after validation guards                                                                                                                                                                                                                                                                                 |
| Type-driven guard simplification           | `npm run compile`; `npm run check`; `npm run test:validation-guards`; `git diff --check`; focused node lane across IPC, storage, protocol, preview, server-state, remote collaboration, persistence, websocket, and app projection owners; focused Solid lane for `PreviewPanel` and notification state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Passed: compile; check; validation 5 files, 50 tests; focused node 41 files, 510 tests; focused Solid 4 files, 35 tests                                                                                                                                                                                                                                                                                                                  |
| Aggressive simplification follow-up        | `npm run typecheck`; `npm run lint`; `npm run format:check`; `npm run test:architecture-guards`; `npm run test:solid:file -- src/components/PreviewPanel.test.tsx src/components/task-panel/TaskPreviewSection.test.tsx`; focused node lane across protocol, task ports, preview proxy, browser IPC command guards, browser websocket, release build scripts, server-state bootstrap/domain guards, durable browser HTTP IPC, agent resume, remote websocket, remote task-command, and WebGL owners; `npm run test:solid:file -- src/remote/App.test.tsx`; `git diff --check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Passed: typecheck; lint; format; architecture 9 files, 41 tests; focused Solid 2 files, 24 tests plus remote App 1 file, 5 tests; focused node 15 files, 116 tests plus remote/WebGL follow-up 3 files, 41 tests; no Python or Rust pending changes were present in this diff                                                                                                                                                            |
| Final pending-change simplification review | `npm run typecheck`; `npm run lint`; `npm run test:validation-guards`; `npm run test:architecture-guards`; `git diff --check`; `npm run test:node:file -- electron/ipc/task-steps.test.ts src/domain/task-steps.test.ts`; targeted owner-local lanes for browser IPC cleanup, websocket command-result lifecycle cleanup, Monaco reveal readiness, remote bootstrap dispatch, remote smoke harness readiness, preview proxy teardown, standalone browser harness seeding, and product-validation docs; focused Chromium canary for preview proxy plus browser task deletion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Passed: typecheck; lint; validation 5 files, 52 tests; architecture 9 files, 41 tests; focused task-steps node lane 2 files, 7 tests; remote bootstrap dispatch lane 3 files, 27 tests; earlier targeted owner-local lanes and Chromium preview/task-deletion canaries passed; no Python or Rust pending changes were present in this diff                                                                                               |
| Pending transport/domain guard sweep       | `npm run test:node:file -- electron/ipc/task-ports.test.ts electron/main-paths.test.ts electron/remote/protocol.test.ts src/app/desktop-session.test.ts src/app/server-state-bootstrap-registry.test.ts src/app/task-command-lease.test.ts src/arena/persistence.test.ts src/domain/git-status.test.ts src/domain/remote-live-ipc-events.test.ts src/domain/server-state-bootstrap.test.ts src/domain/server-state.test.ts src/domain/task-command-controller-projection.test.ts src/domain/task-convergence.test.ts src/domain/task-review-signals.test.ts src/domain/task-review.test.ts src/domain/task-steps.test.ts src/lib/agent-resume.test.ts src/lib/ipc.test.ts src/lib/random-id.test.ts src/lib/terminal-input-batching.test.ts src/lib/websocket-client.test.ts src/remote/remote-collaboration.test.ts src/remote/remote-state-boundary.architecture.test.ts src/remote/remote-task-command.test.ts src/remote/ws.test.ts src/store/client-session.test.ts tests/harness/build-release.test.ts tests/harness/pr-description-validation.test.ts tests/harness/product-validation-objectives.test.ts tests/harness/verify-electron-package.test.ts` | Passed: 30 files, 355 tests                                                                                                                                                                                                                                                                                                                                                                                                              |
| Persistence/bootstrap restore guard        | `npm run test:node:file -- src/store/persistence.test.ts src/store/browser-cold-bootstrap-handoff.test.ts src/store/browser-cold-bootstrap-projection.test.ts src/app/desktop-session.test.ts src/app/server-state-bootstrap.test.ts src/runtime/browser-session.runtime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed: 6 files, 119 tests                                                                                                                                                                                                                                                                                                                                                                                                               |
| Browser HTTP IPC route guard               | `npm run test:node:file -- server/browser-ipc-task-command-args.test.ts server/browser-ipc-command-side-effects.test.ts server/browser-ipc.test.ts server/task-names.test.ts server/browser-server.test.ts tests/harness/standalone-server.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed: 6 files, 44 tests; includes standalone `/remote` shell, `/ws`, `ExposePort -> /_preview` HTTP/HMR websocket composition, and unknown websocket upgrade rejection                                                                                                                                                                                                                                                                 |
| Browser websocket command/output guard     | `npm run test:node:file -- server/browser-terminal-input-tracing.test.ts server/browser-agent-command-executor.test.ts server/browser-agent-command-runner.test.ts server/browser-agent-command-results.test.ts server/browser-agent-output-subscriptions.test.ts server/browser-websocket-task-control.test.ts server/browser-websocket.test.ts server/browser-control-plane.architecture.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed: 8 files, 40 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Storage file semantic guard                | `npm run test:node:file -- electron/ipc/storage.test.ts electron/ipc/system-handlers.test.ts server/browser-server.test.ts tests/harness/standalone-server.test.ts src/store/persistence.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed: 5 files, 83 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Task steps saved-state guard               | `npm run test:node:file -- electron/ipc/task-steps.test.ts src/domain/task-steps.test.ts src/app/task-steps.test.ts electron/ipc/system-handlers.test.ts src/store/persistence.test.ts src/app/desktop-session.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Passed: 6 files, 107 tests                                                                                                                                                                                                                                                                                                                                                                                                               |
| Renderer random-id owner sweep             | `npm run test:node:file -- src/store/projects.test.ts src/store/terminals.test.ts src/store/agents.test.ts src/store/persistence.test.ts src/store/persistence-agent-defaults.test.ts src/app/project-workflows.test.ts src/app/review-session.test.ts src/app/task-workflows.control.test.ts src/app/task-command-lease.test.ts src/lib/client-id.test.ts src/lib/scrollbackRestore.test.ts src/lib/ipc.test.ts src/lib/random-id.test.ts src/components/terminal-view/terminal-input-pipeline.test.ts`; `npm run test:solid:file -- src/arena/BattleScreen.test.tsx src/arena/ConfigScreen.test.tsx src/components/EditProjectDialog.test.tsx src/App.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed: node 14 files, 260 tests; Solid 4 files, 19 tests                                                                                                                                                                                                                                                                                                                                                                                |
| Electron release guardrails                | `npm run compile`; `npm run test:validation-guards`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed: Electron compile plus release/verifier validation guards; release workflow now runs `npm run check` and `npm test` before creating draft releases or packaging Electron artifacts                                                                                                                                                                                                                                                |
| Broad local suite                          | `npm test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Passed: 321 files, 2,493 tests; 1 file and 5 tests skipped; CI now runs the same owner-local behavior suite after the shared static quality gate                                                                                                                                                                                                                                                                                         |
| Startup bundle split                       | `npm run prepare:browser-artifacts`; focused Solid lanes for Monaco, App overlays, Sidebar overlays, TaskPanel dialogs, review panel, preview panel, plan markdown panel, terminal WebGL runtime, terminal web-links runtime, and dialog components; `npm run typecheck`; `npm run check`; `git diff --check`; `npm run test:browser:file -- tests/browser/review-diff-lifecycle.spec.ts --project chromium --workers=1`; `npm run test:browser:terminal:render-stress:startup`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Passed; frontend startup JS chunk reduced from 5,088.17 kB / 1,348.64 kB gzip to 960.87 kB / 272.37 kB gzip, with Monaco isolated in `editor.main` at 3,774.06 kB / 973.93 kB gzip, terminal WebGL isolated in `addon-webgl` at 110.23 kB / 29.92 kB gzip, terminal web links isolated in `addon-web-links` at 2.39 kB / 1.17 kB gzip, and closed overlays/dialogs plus review/preview/plan-markdown surfaces emitted as separate chunks |
| Activity and attention state               | `npm run test:node:file -- src/app/task-presentation-status.test.ts src/app/task-attention.test.ts src/app/task-activity-clock.test.ts src/app/task-steps.test.ts`; `npm run test:solid:file -- src/components/task-panel/TaskStepsSection.test.tsx src/components/task-panel/task-panel-steps-controller.test.tsx src/components/SidebarTaskRow.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Passed: node 4 files, 40 tests; Solid 3 files, 20 tests                                                                                                                                                                                                                                                                                                                                                                                  |
| Attention notification state               | `npm run test:solid:file -- src/app/task-notification-capabilities.test.tsx src/app/task-notification-runtime.test.tsx src/app/task-notification-claims.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed: 3 files, 17 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Permission request blockers                | `npm run test:node:file -- src/components/task-panel/task-panel-permission-controller.test.ts src/components/TaskPanel.architecture.test.ts`; `npm run test:solid:file -- src/components/TaskPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: node 2 files, 6 tests; Solid 1 file, 16 tests                                                                                                                                                                                                                                                                                                                                                                                    |
| Terminal typing and switching              | `npm run test:node:file -- src/app/terminal-focused-input.test.ts src/app/terminal-output-scheduler-policy.test.ts src/app/terminal-attach-scheduler.test.ts src/components/terminal-view/terminal-input-pipeline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Passed: 4 files, 46 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Terminal startup late cleanup              | `npm run test:solid:file -- src/components/terminal-view/terminal-session.test.tsx src/components/TerminalView.test.tsx src/components/terminal-view/terminal-recovery-runtime.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 3 files, 173 tests                                                                                                                                                                                                                                                                                                                                                                                                               |
| Terminal output late cleanup               | `npm run test:node:file -- src/components/terminal-view/terminal-output-pipeline.test.ts src/components/terminal-view/terminal-render-hibernation.test.ts`; `npm run test:solid:file -- src/components/terminal-view/terminal-session.test.tsx src/components/TerminalView.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passed: node 2 files, 51 tests; Solid 2 files, 101 tests                                                                                                                                                                                                                                                                                                                                                                                 |
| Terminal diagnostic presentation           | `npm run test:solid:file -- src/components/TerminalView.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed: 1 file, 58 tests                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Browser-terminal shortcut policy           | `npm run test:node:file -- src/lib/shortcuts.test.ts src/runtime/app-shortcuts.test.ts src/domain/keybindings.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Passed: 3 files, 16 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Direct task switching                      | `npm run test:node:file -- src/store/navigation.test.ts src/store/focus.test.ts src/runtime/app-shortcuts.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Passed: 3 files, 26 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Sidebar focus and resize                   | `npm run test:solid:file -- src/components/Sidebar.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: 1 file, 11 tests                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sidebar task-list focus handle             | `npm run test:solid:file -- src/components/sidebar/SidebarTaskList.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: 1 file, 3 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Resizable panel handle cleanup             | `npm run test:solid:file -- src/components/ResizablePanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed: 1 file, 2 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Window drag lifecycle                      | `npm run test:solid:file -- src/components/TaskPanel.test.tsx src/lib/drag-reorder.test.tsx src/components/Sidebar.test.tsx src/components/ResizablePanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Passed: 4 files, 31 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| New task initialization                    | `npm run test:solid:file -- src/components/NewTaskDialog.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Passed: 1 file, 10 tests                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Task panel focus handles                   | `npm run test:solid:file -- src/components/task-panel/TaskNotesFilesSection.test.tsx src/components/task-panel/task-panel-focus-runtime.test.tsx src/components/TaskPanel.test.tsx src/components/PromptInput.test.tsx src/components/EditableText.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: 5 files, 30 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Changed-files root focus handle            | `npm run test:solid:file -- src/components/ChangedFilesList.test.tsx src/components/task-panel/TaskNotesFilesSection.test.tsx src/components/TaskPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Passed: 3 files, 36 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Shell toolbar focus handle                 | `npm run test:solid:file -- src/components/TaskShellToolbar.test.tsx src/components/task-panel/TaskShellSection.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Passed: 2 files, 10 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Dialog focus ownership                     | `npm run test:solid:file -- src/lib/focus-restore.test.tsx src/components/DisplayNameDialog.test.tsx src/components/ConfirmDialog.test.tsx src/components/EditProjectDialog.test.tsx src/components/ConnectPhoneModal.test.tsx src/components/PathInputDialog.test.tsx src/components/EditableText.test.tsx src/remote/RemoteSessionNameDialog.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 8 files, 23 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Path picker stale-load handling            | `npm run test:solid:file -- src/components/PathInputDialog.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passed: 1 file, 6 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Remote access QR workflow                  | `npm run test:solid:file -- src/components/ConnectPhoneModal.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Passed: 1 file, 4 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Remote access status                       | `npm run test:node:file -- src/app/remote-access.test.ts tests/contracts/remote-status.contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 2 files, 10 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Remote deploy smoke utility                | `npm run test:node:file -- tests/harness/smoke-remote-bootstrap.test.ts tests/harness/product-validation-objectives.test.ts tests/harness/standalone-server.test.ts`; `npm run test:validation-guards`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Passed: focused 3 files, 29 tests; validation 5 files, 50 tests; remote smoke argument parsing, authenticated `/remote` bootstrap URL creation, standalone auth gate and session-cookie redirect behavior, remote shell serving, websocket endpoint reachability, import-safe CLI behavior, authenticated exposed-port preview proxy composition, and validation-lane wiring are owner-local covered before real deployed smoke runs     |
| Remote presence projection                 | `npm run test:node:file -- src/store/peer-presence.test.ts src/remote/remote-collaboration.test.ts src/remote/ws.test.ts src/app/server-state-bootstrap.test.ts`; `npm run test:solid:file -- src/remote/AgentList.test.tsx src/remote/AgentDetail.test.tsx src/components/TaskTitleBar.test.tsx src/components/SidebarFooter.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Passed: node 4 files, 44 tests; Solid 4 files, 34 tests                                                                                                                                                                                                                                                                                                                                                                                  |
| Remote detail responsiveness               | `npm run test:solid:file -- src/remote/AgentDetail.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: 1 file, 8 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Remote dialog lifecycle                    | `npm run test:solid:file -- src/remote/RemoteSessionNameDialog.test.tsx src/remote/App.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Passed: 2 files, 6 tests                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Remote task-state replay                   | `npm run test:node:file -- src/store/server-state-versioning.test.ts src/remote/remote-task-state.test.ts src/remote/remote-collaboration.test.ts src/remote/ws.test.ts src/app/task-review-state.test.ts src/app/task-ports.test.ts src/app/task-attention.test.ts src/store/task-steps.test.ts src/store/task-git-status.test.ts src/app/task-review-signals.test.ts src/app/task-convergence.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 11 files, 71 tests                                                                                                                                                                                                                                                                                                                                                                                                               |
| Remote takeover response ephemerality      | `npm run test:node:file -- src/remote/remote-task-command.test.ts src/remote/remote-collaboration.test.ts src/remote/ws.test.ts`; `npm run test:solid:file -- src/remote/App.test.tsx src/remote/AgentDetail.test.tsx src/remote/AgentList.test.tsx src/remote/AgentDetailControls.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: node 3 files, 56 tests; Solid 4 files, 33 tests; takeover approvals/denials now require the current open remote control transport instead of waiting across reconnect, and the mobile shell re-enables the request if the response cannot be sent                                                                                                                                                                                |
| Task-command lease generation              | `npm run test:node:file -- src/app/task-command-lease.test.ts src/app/task-workflows.control.test.ts tests/contracts/task-command-takeover.contract.test.ts electron/ipc/task-command-leases.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Passed: 4 files, 116 tests                                                                                                                                                                                                                                                                                                                                                                                                               |
| Task-command controller renewals           | `npm run test:node:file -- src/store/task-command-controllers.state.test.ts src/store/task-command-controllers.load.test.ts src/domain/task-command-controller-projection.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Passed: 3 files, 13 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Versioned state ordering                   | `npm run test:node:file -- src/store/server-state-versioning.test.ts src/app/task-ports.test.ts src/remote/remote-task-state.test.ts src/remote/remote-collaboration.test.ts src/remote/ws.test.ts src/app/server-state-bootstrap.test.ts src/app/task-review-state.test.ts src/app/task-convergence.test.ts src/app/task-review-signals.test.ts src/app/task-attention.test.ts src/store/task-steps.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Passed: 11 files, 71 tests                                                                                                                                                                                                                                                                                                                                                                                                               |
| Review and diffs                           | `npm run test:node:file -- electron/ipc/task-review-state.test.ts electron/ipc/git-diff-ops.test.ts src/app/review-files.test.ts src/app/review-diffs.test.ts tests/contracts/review-diff.contract.test.ts src/lib/changed-file-display.test.ts src/lib/changed-file-projection.test.ts`; `npm run test:solid:file -- src/components/ScrollingDiffView.test.tsx src/components/InlineInput.test.tsx src/components/ReviewPanel.test.tsx src/components/ChangedFilesList.test.tsx src/components/review-panel/ReviewPanelFileList.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Passed: node 7 files, 54 tests; Solid 5 files, 60 tests                                                                                                                                                                                                                                                                                                                                                                                  |
| Monaco diff lifecycle                      | `npm run test:solid:file -- src/components/MonacoDiffEditor.test.tsx src/components/review-panel/ReviewPanelDiffPane.test.tsx src/components/ReviewPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Passed: 3 files, 29 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Plan review scroll ownership               | `npm run test:solid:file -- src/components/PlanViewerDialog.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Passed: 1 file, 13 tests                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Destructive git dialogs                    | `npm run test:solid:file -- src/components/CloseTaskDialog.test.tsx src/components/MergeDialog.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 2 files, 13 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Task push completion identity              | `npm run test:solid:file -- src/components/PushDialog.test.tsx src/components/TaskPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed: 2 files, 19 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Preview and port exposure                  | `npm run test:node:file -- server/browser-preview.test.ts electron/ipc/task-ports.test.ts src/app/task-ports.test.ts`; `npm run test:solid:file -- src/components/task-panel/task-panel-preview-controller.test.tsx src/components/PreviewPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Passed: node 3 files, 46 tests; Solid 2 files, 32 tests                                                                                                                                                                                                                                                                                                                                                                                  |
| Preview browser proxy canary               | `npm run test:browser:preview`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Passed: 1 Chromium test; proves authenticated exposed preview navigation, injected browser base path, root-relative module loading, browser cookie-jar forwarding to preview subresources, and Parallel Code auth/session stripping before the target                                                                                                                                                                                    |
| Task-container preview routing             | `npm run test:node:file -- server/browser-preview.test.ts src/app/task-containers.test.ts src/app/task-ports.test.ts electron/ipc/task-containers.test.ts electron/ipc/task-ports.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Passed: 5 files, 64 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Preview explicit port scan                 | `npm run test:solid:file -- src/components/task-panel/task-panel-preview-controller.test.tsx src/components/PreviewPanel.test.tsx src/components/TaskPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passed: 3 files, 48 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Preview expose request ordering            | `npm run test:solid:file -- src/components/PreviewPanel.test.tsx src/components/task-panel/task-panel-preview-controller.test.tsx src/components/TaskPanel.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passed: 3 files, 49 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Preview probe diagnostics                  | `npm run test:node:file -- electron/ipc/runtime-diagnostics.test.ts electron/ipc/task-ports.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passed: 2 files, 20 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Remote, multi-client, replay               | `npm run test:contracts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 8 files, 42 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Auth/bootstrap/reconnect                   | `npm run test:node:file -- electron/remote/ws-server.test.ts server/browser-control-plane.test.ts electron/remote/ws-transport.test.ts tests/contracts/reconnect-replay.contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Passed: 4 files, 46 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Startup/restore cancellation               | `npm run test:node:file -- src/app/browser-startup.test.ts src/app/runtime-diagnostics.test.ts src/runtime/browser-session.runtime.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Passed: 3 files, 23 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Control/backpressure diagnostics           | `npm run test:node:file -- electron/ipc/runtime-diagnostics.test.ts server/browser-control-plane.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Passed: 2 files, 38 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Long-lived control-plane churn             | `npm run test:node:file -- server/browser-control-plane.test.ts tests/contracts/control-plane-stress.contract.test.ts tests/contracts/reconnect-replay.contract.test.ts electron/remote/ws-transport.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Passed: 4 files, 44 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Control-plane teardown queues              | `npm run test:node:file -- server/browser-control-plane.test.ts tests/contracts/control-plane-stress.contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Passed: 2 files, 38 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Selected-surface attach admission          | `npm run test:node:file -- src/app/terminal-attach-scheduler.test.ts src/store/terminal-startup.test.ts src/app/app-startup-status.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Passed: 3 files, 14 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Resize authority release                   | `npm run test:node:file -- src/components/terminal-view/terminal-input-pipeline.test.ts server/session-stress.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Passed: 2 files, 38 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Preview action revision guard              | `npm run test:solid:file -- src/components/PreviewPanel.test.tsx src/components/task-panel/TaskPreviewSection.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Passed: 2 files, 24 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| State legibility UI                        | `npm run test:solid:file -- src/components/task-control-visual-state.test.tsx src/components/PreviewPanel.test.tsx src/components/ReviewPanel.test.tsx src/components/SidebarTaskRow.test.tsx src/components/PromptInput.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Passed: 5 files, 65 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Review inline insertion projection         | `npm run test:solid:file -- src/components/ScrollingDiffView.test.tsx src/components/ReviewPanel.test.tsx src/components/ChangedFilesList.test.tsx src/components/review-panel/ReviewPanelFileList.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Passed: 4 files, 59 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Task deletion stale-state cleanup          | `npm run test:node:file -- src/store/task-state-cleanup.test.ts src/store/terminals.test.ts src/app/task-workflows.control.test.ts src/store/persistence.test.ts src/store/client-session.test.ts`; `npm run test:browser:task-deletion`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed: 5 node files, 112 tests; focused Chromium canary proves a current-branch browser task can close cleanly while review and preview are open                                                                                                                                                                                                                                                                                        |
| Bootstrap ownership symmetry               | `npm run test:node:file -- src/app/server-state-bootstrap-registry.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Passed: 1 file, 5 tests                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Startup, restore, and replay               | `npm run test:node:file -- src/app/server-state-bootstrap.test.ts src/app/session-bootstrap-controller.test.ts src/app/desktop-session.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Passed: 3 files, 52 tests                                                                                                                                                                                                                                                                                                                                                                                                                |
| Lifecycle contract lane                    | `npm run test:contracts:lifecycle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Passed: node 24 files, 403 tests; Solid 3 files, 155 tests; includes the long-lived control-plane stress contract, selected-surface attach scheduler budget owner test, and peer-controlled resize geometry proof                                                                                                                                                                                                                        |

Targeted browser lane run:

- The review surface and Monaco startup splits moved review diff rendering across browser
  dynamic-import boundaries, so `npm run test:browser:file --
tests/browser/review-diff-lifecycle.spec.ts --project chromium --workers=1` was run to prove the
  standalone browser server can load the split review/editor chunks and still render worktree and
  branch diffs.
- The preview startup split is limited to a Solid lazy boundary around the existing preview panel.
  Focused owner-local tests and the production artifact build prove the callbacks and emitted chunk;
  preview proxy routing, cookies, iframe/window behavior, websocket auth, and real navigation are
  unchanged.
- The preview proxy and explicit port-exposure path crosses browser-only navigation and cookie-jar
  behavior, so `npm run test:browser:preview` was run. Chromium proved authenticated
  exposed-preview navigation, injected base path behavior, root-relative module loading, target
  cookie forwarding to preview subresources, and Parallel Code auth/session stripping before the
  target receives requests.
- The browser task deletion cleanup touched browser HTTP IPC side effects and stale review/preview
  surfaces, so `npm run test:browser:task-deletion` was run. Chromium proved a current-branch task
  can be closed from browser/server mode while review and preview panels are open, with the deleted
  task removed from the task panel and no browser error state.
- The remote shell, websocket client/protocol, and browser route changes cross browser-only auth,
  bootstrap, mobile viewport, and multi-context ownership seams, so `npm run test:browser:remote`
  was run after refreshing browser artifacts. Chromium passed the tokenized remote shell load,
  mobile session naming and focus release, desktop/mobile ownership sync with takeover approval,
  and mobile reconnect typing/ownership recovery.
- The plan markdown startup split is limited to moving sanitized inline plan rendering behind the
  existing plan-tab visibility boundary. Focused Solid tests prove sanitization, keyboard open, and
  shared markdown-viewer wiring; the architecture guard keeps the markdown renderer out of the
  default task-panel startup path. Browser focus, navigation, cookies, websocket auth,
  multi-context coordination, and real preview paint are unchanged.
- The terminal WebGL startup split moved the optional renderer addon behind focused-terminal
  readiness while keeping the DOM renderer as the immediate paint path, so `npm run
test:browser:terminal:render-stress:startup` was run to prove large startup buffers and selected
  shell paint-readiness still work in Chromium with the emitted async WebGL chunk.

Browser lanes intentionally not run:

- The App, Sidebar, and TaskPanel closed-overlay splits are production chunking plus Solid mount
  boundary changes. The focused Solid lanes prove the lazily loaded dialogs still open, close, and
  preserve their owner-local workflow state; the production artifact build proves the chunks are
  emitted without stale eager imports. Browser focus, navigation, cookies, websocket auth,
  multi-context coordination, and real terminal/preview paint are unchanged.
- The preview cookie change is limited to deterministic server-side `Set-Cookie` header rewriting
  at the proxy seam. The test asserts target `Domain` stripping and preview-path scoping directly;
  no real browser navigation, cookie-jar storage flow, iframe/window behavior, focus, paint,
  visibility, websocket auth, or multi-context coordination changed.
- The preview websocket upgrade ownership fix is a backend/server upgrade-routing contract. Source
  tests and the spawned standalone server prove `/ws`, `/remote`, `ExposePort -> /_preview` HTTP,
  HMR websocket forwarding, auth/header/token stripping, malformed preview upgrade rejection, and
  unknown upgrade rejection; no browser DOM websocket API behavior, iframe paint/focus, or
  multi-context UI coordination changed.
- The task-port validation token change is a backend registry state-machine race and is covered at
  the task-port owner seam before any browser preview consumes the corrupted state.
- The preview expose focus-control change is a task-panel workflow race covered at the Solid
  controller seam; no preview proxy routing, cookie handling, iframe/window behavior, websocket auth,
  or multi-context browser coordination changed.
- The preview expose request ordering cleanup is a Solid presentation/workflow-state fix. The
  regressions prove only one expose request can be initiated through the UI at a time and stale
  expose completions cannot race selected preview, error, or busy state; backend exposure truth,
  preview proxy routing, cookies, iframe/window behavior, websocket auth, multi-context
  coordination, and real navigation are unchanged.
- The preview unexpose failure cleanup is a Solid presentation/workflow-state fix. The regression
  proves failed exposure revocation stays visible on the affected port card and clears when backend
  exposure truth removes the port; preview proxy routing, cookie handling, iframe/window behavior,
  websocket auth, and real navigation are unchanged.
- The preview exposure-index cleanup is a Solid presentation/projection simplification. The
  regression proves the selected embedded preview remains stable when backend snapshots update other
  exposed-port metadata; preview proxy routing, cookie handling, iframe/window behavior, websocket
  auth, multi-context coordination, and real navigation are unchanged.
- The preview action revision guard is a Solid presentation/workflow-state fix. The regressions
  prove stale expose, refresh, and unexpose failures for older task-port revisions cannot block
  auto-refresh, publish errors onto newer backend preview truth for the same port, or keep preview
  actions disabled after backend exposure truth has already made the action obsolete; preview proxy
  routing, cookie handling, iframe/window behavior, websocket auth, multi-context coordination, and
  real navigation are unchanged.
- The aggressive simplification follow-up is a type-driven cleanup across recently touched
  TypeScript/JavaScript seams. It centralizes task/local preview-port ordering, closes browser IPC
  command maps over explicit channel subsets, consolidates preview HTTP/websocket failure handling,
  removes duplicated tuple/key membership mirrors where the tuple or metadata record is already the
  owner, moves preview busy state to a closed action union keyed by backend revisions, and replaces
  repeated latest-request counters in the task preview controller with a small tracker helper. It
  also collapses remote navigation into a single closed view state, moves remote task-command lease
  ownership to a retained/idle union, consolidates WebGL priority metadata into one record, and
  replaces repeated unsafe terminal/websocket test adapters with typed factory helpers.
  Browser-only risks such as real navigation, cookies, deployed websocket auth, and multi-context
  coordination are unchanged and intentionally left to targeted browser lanes when those owners
  move; remote App focus/presentation stayed covered by owner-local Solid proof.
- The full non-browser gate was refreshed after the preview-props accessor simplification exposed
  stale test assumptions. `npm test` now passes across node/default, server terminal
  latency/session-stress, and Solid UI suites, including TaskPanel preview-manager and
  task-panel-preview-controller coverage for explicit scan/expose flows, stale action errors, and
  container inspect/log/action state projection.
- The permission-request blocker cleanup is a task-panel controller projection simplification. The
  regressions prove duplicate agent labels stay disambiguated, stale/non-task requests stay hidden,
  and approval/denial still routes through the owning agent; terminal writes, backend leases,
  browser focus, websocket auth, multi-context coordination, and real paint are unchanged.
- The task-step expansion cleanup is a Solid presentation-state fix. The regression proves expanded
  history details stay keyed to the same backend step identity instead of leaking to a different
  row after the snapshot changes; backend step storage, terminal jumps, browser focus, websocket
  auth, multi-context coordination, and real paint are unchanged.
- The task-panel focus-handle cleanup is a Solid owner-local focus API fix. The regressions prove
  custom component focus/edit handles use explicit callback props, hidden notes and changed-files
  refs are cleared when replaced, sidebar task-list, changed-files, and shell-toolbar root refs
  clear on unmount, and prompt/edit plus resizable-panel programmatic handles clear on unmount;
  backend task-command leases, terminal PTY writes, browser navigation, websocket auth,
  multi-context coordination, and real paint are unchanged.
- The terminal anomaly presentation cleanup is a Solid diagnostic projection simplification. The
  regression proves multiple terminal anomalies still expose the combined count, kind list, worst
  severity, and overlay label while the component derives them in one pass; terminal runtime
  scheduling, PTY ownership, browser focus, websocket auth, multi-context coordination, and real
  paint are unchanged.
- The terminal startup late-cleanup fix is a Solid terminal-session lifecycle guard. The regressions
  prove late `SpawnAgent` and existing-session attach-recovery completions do not mark attach bound,
  notify spawn ready, or run flow-control recovery after the view has been cleaned up; backend PTY
  spawning, websocket protocol, browser focus, real terminal canvas paint, and multi-context
  coordination are unchanged.
- The terminal takeover late-cleanup fix is a Solid terminal view/session lifecycle guard. The
  regression proves a late approved takeover cannot move task focus or focus a cleaned-up terminal
  session; backend task-command takeover truth, PTY writes, websocket auth, real terminal canvas
  paint, and multi-context coordination are unchanged.
- The terminal recovery-runtime disposal cleanup is a Solid terminal runtime lifecycle fix. The
  regressions prove hidden startup paint waits and visible-sibling startup readiness waits clean up
  subscriptions and timeout handles when the runtime is disposed; backend recovery snapshots, PTY
  pause/resume semantics, websocket reconnect protocol, real terminal canvas paint, and
  multi-context coordination are unchanged.
- The terminal render-hibernation late-cleanup fix is a terminal-session lifecycle guard. The
  regression proves a late prewarm restore completion cannot publish hibernation changes or schedule
  output flush after cleanup; backend PTY output, browser focus, real terminal canvas paint, and
  multi-context coordination are unchanged.
- The terminal output-pipeline late-cleanup fix is a terminal output lifecycle guard. The regression
  proves a late xterm write completion clears in-flight bookkeeping without publishing render,
  ready, or queue-empty side effects after cleanup; backend PTY output, browser focus, real terminal
  canvas paint, and multi-context coordination are unchanged.
- The task deletion stale-state cleanup is a store-owner consistency fix for task-scoped review,
  permission, takeover, focus, and layout records; no browser navigation, paint, websocket auth, or
  multi-context coordination behavior changed.
- The task-command controller renewal cleanup is a store-owner projection fix. The regression proves
  accepted lease-renewal versions still advance local version truth without notifying terminal
  subscribers when controller id and action are unchanged; backend lease ownership, browser focus,
  websocket auth, real terminal paint, and multi-context coordination are unchanged.
- The sidebar focused-project scroll cleanup is Solid owner-local lifecycle scheduling. The
  regression proves rapid project-focus changes cancel stale scroll frames before they can jump the
  sidebar back to an older project; routing, browser history, websocket auth, real paint, and
  multi-context coordination are unchanged.
- The sidebar resize persistence cleanup is Solid owner-local drag workflow state. The regression
  proves resize drags update the local visual width immediately while committing persisted panel
  size once on drag end; layout persistence ownership, browser focus, paint timing, websocket auth,
  and multi-context coordination are unchanged.
- The new-task initialization cleanup is Solid owner-local dialog workflow state. The regression
  proves a stale agent-catalog load from a closed dialog cannot overwrite the current reopened
  dialog's selected agent/defaults; backend task creation, git worktree creation, websocket auth,
  route navigation, paint, and multi-context coordination are unchanged.
- The new-task ignored-directory warning is Solid owner-local dialog workflow state. The regression
  proves backend-owned ignored-directory suggestion failures become visible without blocking task
  creation; backend gitignore discovery, worktree creation, websocket auth, route navigation, paint,
  and multi-context coordination are unchanged.
- The destructive git-dialog stale validation cleanup is Solid owner-local workflow state. The
  regressions prove stale close/merge git-status checks and stale merge failures cannot verify or
  dirty the currently displayed task; backend git status ownership, filesystem mutation, browser
  navigation, websocket auth, paint, and multi-context coordination are unchanged.
- The plan review scroll-restore cleanup is Solid owner-local lifecycle scheduling. The regression
  proves a pending scroll restore is canceled before a closed/reopened plan viewer can receive stale
  scroll position; markdown rendering, editor opening, route navigation, websocket auth, paint, and
  multi-context coordination are unchanged.
- The remote-access generation changes are app-workflow state-machine guards around deterministic
  start/stop/refresh ordering; no remote route auth, mobile shell behavior, websocket bootstrap, or
  multi-context browser coordination changed.
- The task-command lease generation cleanup is an app-workflow/control-plane lease fix. The
  regressions prove stale acquire cleanup releases the exact backend lease generation it acquired
  after transport disconnect, and the lease/workflow/takeover owner contracts still pass; websocket
  protocol shape, route auth, real multi-context coordination, browser focus, and paint are
  unchanged.
- The remote QR generation cleanup is Solid owner-local workflow state. The regression proves stale
  QR image generation cannot overwrite the current mode URL; remote access backend status, route
  auth, QR library behavior, navigation, websocket auth, paint, and multi-context coordination are
  unchanged.
- The remote detail fit-frame cleanup is a component lifecycle scheduling fix that bounds redundant
  remote terminal fit/resize work; no websocket protocol, multi-client coordination, terminal canvas
  rendering contract, or browser navigation behavior changed.
- The remote detail selected-agent projection cleanup is a component projection performance fix. The
  regression proves the selected remote agent name/context comes from the matching agent while the
  detail view reads the remote agent list at most once per selected-agent snapshot; websocket
  protocol, backend replay, multi-client authority, browser navigation, and real paint are
  unchanged.
- The remote agent-list derivation cleanup is a Solid owner-local projection performance fix. The
  regressions prove owner, supervision, review, and port state are read once per agent for the
  stable list model instead of being recomputed separately for sorting, counts, and cards, and that
  volatile live-preview updates do not rederive that stable metadata; websocket protocol, backend
  replay, multi-client authority, browser focus, paint, and navigation are unchanged.
- The remote stale-takeover result guard is a remote detail workflow-state fix that ignores ownership
  notices for a task that is no longer selected; backend takeover authority and websocket brokering
  are unchanged.
- The remote stale-send result guard is a remote detail workflow-state fix that ignores failed send
  notices for a task that is no longer selected; backend leases, write ordering, and websocket
  transport behavior are unchanged.
- The remote detail delayed-scroll/resize cleanup is a remote detail workflow-state fix that
  cancels task-scoped timers during task handoff and verifies debounced resize sends still belong to
  the active task; terminal protocol writes, websocket brokering, browser navigation, and real
  viewport geometry are unchanged.
- The remote takeover-response ephemerality fix is a remote task-command workflow guard. Owner-local
  tests prove approve/deny responses use only the current open websocket transport, are not queued
  across reconnect, and clear the mobile shell's busy state when the response cannot be sent;
  backend takeover authority, websocket protocol parsing, real multi-context focus, navigation, and
  paint are unchanged.
- The remote session-name focus-frame cleanup is a Solid owner-local dialog lifecycle fix that
  cancels stale input focus after the dialog closes; no websocket auth, route navigation, real paint,
  or multi-context coordination changed.
- The dialog focus-frame cleanup is an owner-local lifecycle fix across modal/title/path/remote
  focus scheduling. The Solid regressions assert stale callbacks are canceled before they can call
  `focus()` after their owner closes; focus target selection, keyboard routing, hidden-tab behavior,
  route navigation, websocket auth, and paint are unchanged.
- The task push completion identity fix is renderer workflow state cleanup. The Solid regressions
  prove hidden push notifications use the task/branch captured at push start and that stale output
  auto-scroll frames are canceled after close; backend git execution, filesystem state, browser
  navigation, websocket auth, real paint, and multi-context coordination are unchanged.
- The notification claim storage cleanup is a Solid/browser-storage owner fix. The regression
  proves malformed local notification-claim records are ignored without blocking a current tab's
  claim while valid ownership records still suppress duplicate notifications; notification click
  focus, real browser notification permission prompts, websocket auth, and multi-context
  coordination are unchanged.
- The path picker stale-load fix is Solid owner-local dialog workflow cleanup. The regression proves
  stale recent-project loads cannot repopulate a reopened picker; filesystem IPC handlers, native
  file dialogs, browser navigation, websocket auth, real paint, and multi-context coordination are
  unchanged.
- The review/diff animation-frame cleanup is limited to Solid owner-local lifecycle scheduling. The
  Solid regression proves stale scroll-target callbacks are canceled after unmount; no browser
  navigation, websocket auth, multi-context coordination, or real paint behavior changed.
- The Monaco diff lifecycle cleanup is limited to Solid owner-local editor lifecycle management.
  The regression proves the hidden-lines click shim and diff-update subscription stop reacting
  after unmount while editor/model disposal still runs; diff parsing, backend review truth, browser
  navigation, websocket auth, multi-context coordination, and real paint are unchanged.
- The review inline insertion projection cleanup is a pure Solid review-rendering performance fix.
  The regression proves inline review comments and ask-code questions still render at the correct
  diff lines while the review session's annotation/question accessors are read once for the rendered
  diff instead of once per line; backend git/diff truth, browser navigation, websocket auth,
  multi-context coordination, and real paint are unchanged.
- The versioned server-state ordering cleanup is a store projection correctness fix. The
  regressions prove versioned backend truth rejects stale unversioned invoke echoes for task-port
  snapshots/removals, including same-millisecond updates, while the existing remote/task review,
  convergence, attention, and step state lanes still accept valid owner-local ordering; browser
  navigation, websocket auth, multi-context coordination, preview proxy routing, and real paint are
  unchanged.
- The preview explicit port-scan cleanup is a task-panel workflow performance fix. The regressions
  prove opening or focusing the preview manager consumes existing task-port snapshot state without
  implicitly running the backend listener scan, and that explicit refresh still scans the current
  worktree and surfaces scan failures; preview proxy routing, cookies, iframe/window behavior,
  websocket auth, multi-context coordination, and real navigation are unchanged.
- The task-container preview routing cleanup is a server/app preview boundary fix. The regressions
  prove exposed task-port previews stay on `/_preview/...`, task-container previews use
  `/_container_preview/...`, same-task/same-port collisions resolve to the correct upstream target,
  detected base-path caches are scoped by preview kind, and container/exposed browser URL builders
  stay distinct; cookie rewriting, root-relative and loopback-absolute redirect rewriting,
  HTTP/websocket preview-token query stripping, HTTP/websocket proxy header stripping, websocket upgrades,
  task-port exposure ownership, and task-container preview target ownership remain covered at the
  owner-local proxy/backend seams. Real browser navigation, iframe/window behavior, websocket auth,
  multi-context coordination, focus, and paint were not changed.
- The window drag lifecycle cleanup is limited to owner-local mouse drag session cleanup. The
  regressions prove sidebar resize, sidebar task drag, shared title reorder drag, and resizable
  panel drag sessions remove window listeners and clear transient drag state when their owning
  Solid component unmounts; browser navigation, websocket auth, backend task ordering truth, real
  paint, and multi-context coordination are unchanged.
- The review commit-history failure cleanup is a Solid presentation/workflow-state fix. The
  regression proves branch history failures remain visible without hiding the canonical review file
  list and clear when a later history request succeeds; backend git diff ownership, browser
  navigation, websocket auth, multi-context coordination, and real paint are unchanged.
- The changed-files refresh failure cleanup is a Solid owner-local workflow/presentation-state fix.
  The regressions prove worktree refresh failures stay visible and preserve the last-known file list;
  backend git/diff ownership, browser navigation, websocket auth, multi-context coordination, and
  real paint are unchanged.
- The changed-file display disambiguation cleanup is a pure review projection-helper performance
  fix. The regressions prove repeated filenames still get the shortest unique directory suffix,
  root files and repeated-path edge cases keep their prior labels, and both changed-files and review
  panel file-list consumers still render through the same Solid review lane; backend git/diff truth,
  browser navigation, websocket auth, multi-context coordination, and real paint are unchanged.
- The changed-files footer stats cleanup is a pure Solid review projection performance fix. The
  existing footer regressions prove committed totals and uncommitted counts stay visible and
  correctly separated while the implementation derives them in one pass over the visible files;
  backend git/diff truth, browser navigation, websocket auth, multi-context coordination, and real
  paint are unchanged.
- The changed-files Hydra visibility cleanup is a pure Solid review projection performance fix. The
  existing Hydra-hidden regression proves coordination artifacts stay hidden until requested and
  still contribute the hidden summary, while the implementation derives visibility and hidden count
  through one projection; backend git/diff truth, browser navigation, websocket auth,
  multi-context coordination, and real paint are unchanged.
- The changed-file projection helper cleanup is a pure review projection performance and
  consistency fix. Direct regressions prove line-total modes stay explicit and hidden Hydra artifacts
  are still counted even when another visibility predicate excludes them, while Solid regressions
  prove both changed-files and review-panel consumers keep rendering the same states; backend
  git/diff truth, browser navigation, websocket auth, multi-context coordination, and real paint are
  unchanged.
- The task-steps load failure cleanup is a Solid workflow/presentation-state fix. The regressions
  prove failed full-step snapshot loads become visible without hiding existing backend-owned step
  history and do not leak unhandled rejections; backend file watching, replay, browser navigation,
  websocket auth, multi-context coordination, and real paint are unchanged.
- The collapsed sidebar attention cleanup is a Solid presentation fix. The regression proves
  collapsed task rows keep the same compact attention signal as expanded rows without rendering noisy
  output previews; backend supervision truth, sidebar routing, browser navigation, websocket auth,
  multi-context coordination, and real paint are unchanged.
- The prompt send failure cleanup is a Solid workflow/presentation-state fix. The regressions prove
  failed or denied prompt sends keep the draft visible and explain why the send did not complete;
  backend task-command leases, PTY writes, terminal rendering, websocket auth, browser focus, and
  multi-context coordination are unchanged.
- The server-side websocket auth/bootstrap replay-ordering change is covered at the
  control-plane/transport seam; the remaining risk is protocol ordering, not browser runtime
  behavior.
- The control-plane queued-send teardown cleanup is backend owner lifecycle hardening. The focused
  node lane proves shutdown clears pending micro-batched control sends and simulated delayed
  channel sends before late timers can publish stale messages or diagnostics after teardown;
  browser focus, paint, navigation, websocket auth sequencing, and real multi-context coordination
  are unchanged.
- The selected-surface attach admission cleanup is an app scheduler policy fix. The focused node
  lane proves background attach work can still use the documented two-slot budget while a newly
  selected/foreground terminal gets admitted immediately instead of waiting for background release;
  browser focus, paint, hidden-tab behavior, websocket auth sequencing, and real viewport timing are
  unchanged.
- The resize authority release cleanup is a terminal input-pipeline ownership fix. The focused node
  lane proves a resize deferred behind peer task control flushes the latest geometry when controller
  truth clears to unowned, instead of waiting for a later takeover or resize event; browser viewport
  geometry, focus, paint, websocket auth sequencing, and real multi-context coordination are
  unchanged.
- The pending transport/domain guard sweep is owner-local parser and projection hardening. The
  regressions cover malformed bootstrap snapshots, unknown and malformed known browser/remote
  websocket server messages through the shared protocol guard, client websocket parser rejection for
  unknown finite states and unpaired control context, stricter finite-state and numeric payload
  guards, shared TCP port validation for preview, remote-access, route, and restored exposure
  state, non-negative integer state-version ordering across store and remote projections, stale
  task-command-controller replay ordering, remote task-command lease generation release races,
  unchanged-renew notification suppression, and request-tracked browser terminal input waiting for
  backend acceptance even when the caller omits a request id. It also covers
  stable remote task-command lease owner fallback when browser session storage is unavailable, the
  renderer random-id helper across native `randomUUID`, `getRandomValues`, and UUID-shaped fallback
  paths so remote browser HTTP origins do not depend on secure-context-only ID generation, and
  durable browser HTTP IPC queue replay validation so stale or malformed session storage cannot
  enqueue arbitrary backend IPC after reload, and browser-local client-session validation so
  malformed session storage cannot crash selected-surface restore or apply non-finite layout scale;
  it also covers persisted Arena preset/history validation so malformed saved match data cannot
  crash config or history surfaces, and persisted task-port validation so malformed saved exposure
  state cannot crash restart restore or rediscovery.
- The persistence/bootstrap restore guard is owner-local startup and persistence hardening. The
  regressions prove malformed same-tab cold-bootstrap handoff payloads are rejected, malformed
  persisted workspace containers are skipped before mutating store truth, malformed task entries do
  not hydrate invalid tasks, legacy `projectRoot` migration covers collapsed tasks as well as active
  tasks, and stale saved active selection falls back to the first restored panel with the correct
  active agent. Browser focus, paint, navigation, cookies, websocket auth sequencing, and real
  multi-context coordination are unchanged.
- The browser HTTP IPC route guard is transport-boundary hardening for the browser/server command
  plane. The regressions prove unknown IPC route params are rejected before dispatch, arrays, null,
  strings, and numbers cannot reach handlers as forged args, valid browser client identity is still
  injected into command requests, create-task responses still update browser-visible task metadata
  and task-created broadcasts, delete-task requests still remove metadata, refresh the affected git
  owner, and clear stale worktree status, standalone server HTTP IPC still works, malformed saved
  task-name registry state cannot replace existing remote task labels, save-state requests still
  replay task-name metadata through the side-effect owner, merge and push requests still emit
  branch-scoped git refreshes, and the architecture guard keeps task-event/git-refresh policy behind
  the command side-effect owner and PTY metadata lookup behind the task-command argument owner
  instead of the HTTP route. Browser focus, paint, navigation, cookies, websocket auth sequencing,
  and real multi-context coordination are unchanged.
- The browser websocket command/output guard is transport-boundary hardening for terminal input,
  resize authority, and remote terminal output subscriptions. The regressions prove websocket
  task-control checks reject missing or mismatched browser identity, preserve legacy behavior when
  no task id can be resolved, prefer explicit task ids before backend metadata lookup, verify
  controller ownership when task ids are known, and keep stale agent-controller recovery tied to
  backend task-command ownership. They also prove request-tracked terminal command results stay
  keyed by client, command, agent, and request id, expire on their TTL, clear prune timers, and evict
  oldest entries at capacity so reconnect replay cannot duplicate accepted writes indefinitely.
  Output-subscription regressions prove scrollback is sent before live subscription, duplicate
  client/agent subscriptions are ignored, closed clients do not receive output, and explicit
  unsubscribe plus client cleanup release backend subscriptions. Command-runner regressions prove
  cached request results skip duplicate execution, request-tracked claim and execution failures use
  `agent-command-result` instead of broad agent errors, stale controllers are released and retried
  only when backend task ownership says they no longer own the task, and non-request-tracked
  task-control failures still fall back to `agent-error`. Command-executor regressions prove PTY
  input, resize, pause, resume, kill, and permission-response writes stay in the command executor
  owner instead of the websocket route. Terminal input trace regressions prove input preview
  formatting, trace-request creation, server-received records, failure recording no-ops without
  request ids, and clock-sync timestamps stay covered outside the route. The architecture guard
  keeps PTY metadata lookup, task-command lease checks, command-result cache maps, command
  execution/error policy, PTY command mutations, backend output subscription reads, and terminal
  trace diagnostics behind focused owners instead of the websocket route. Browser focus, paint,
  navigation, cookies, websocket auth sequencing, and real multi-context coordination are unchanged.
- The storage file semantic guard is backend persistence-owner hardening. The regressions prove
  Electron app-state and browser workspace-state saves reject non-object state payloads before
  writing, syntactically valid but semantically invalid primary state files fall back to backups,
  system handlers still load/save through the same storage seam, standalone browser startup still
  reads saved state, and renderer persistence still applies valid saved state. Browser focus, paint,
  navigation, cookies, websocket auth sequencing, and real multi-context coordination are unchanged.
- The task steps saved-state guard is backend task-step owner hardening. The regressions prove
  malformed saved workspace metadata cannot delete existing task-step watcher state, valid empty
  metadata still clears removed tasks, mixed malformed and valid entries still sync the valid tracked
  task, and the desktop startup/bootstrap path still drains task-step state. Browser focus, paint,
  navigation, cookies, websocket auth sequencing, and real multi-context coordination are unchanged.
- The Electron release guardrails are build and packaging verifier changes. The regressions cover
  release cleanup, step ordering, package archive contents, packaged `main`, freshness inputs, and
  test-artifact exclusion; browser runtime behavior, preview routing, remote route auth, terminal
  paint, and multi-context coordination are unchanged.
- The remote deploy smoke utility change is harness hardening for the existing `smoke:remote`
  command. The regressions prove CLI parsing, authenticated remote URL construction, auth-fallback
  detection, websocket wait behavior, import-safe utility reuse, and live standalone `/remote`
  auth/session/static-shell plus `/ws` reachability without launching a real browser. They also
  prove the authenticated standalone `ExposePort` HTTP IPC path wires through to `/_preview` with
  unexposed local targets denied before the explicit expose call, missing-session and hostile-origin
  preview requests denied after exposure, Parallel Code auth and session cookies stripped before the
  target, target cookie path scoping, preview auth-token query stripping, root-relative asset
  rewriting, and forwarded target path/query; deployed routing, TLS, real browser paint, browser
  cookie-jar storage, iframe/window behavior, and multi-context coordination still belong to
  explicit deployed smoke or browser-lab runs.
- The lanes above prove owner-local behavior for the changed docs, review guardrails, documented
  proof map, peer-controlled resize geometry preservation, and reconnect auth/bootstrap replay
  ordering.
