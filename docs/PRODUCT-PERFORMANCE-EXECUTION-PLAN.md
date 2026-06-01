# Product Performance Execution Plan

This document is the implementation plan for turning the browser-first product goal into measured
product behavior. The work starts in product code. Review gates protect the result, but they are not
the strategy.

Use this when deciding what to build next to make Parallel Code feel desktop-native in the browser.
For user-frustration taxonomy, use
[PRODUCT-VALIDATION-OBJECTIVES.md](./PRODUCT-VALIDATION-OBJECTIVES.md). For ownership rules, use
[ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md). For validation layer choice, use
[TESTING.md](./TESTING.md).

## Recommended Objective

Make the browser/server runtime feel measurably like a desktop coding cockpit under realistic
multi-agent load. The selected task, terminal input, task switching, review diff, preview, remote
session, reconnect, and cleanup flows must become useful within explicit product budgets while
preserving backend-owned truth and visible user control.

Build the product code around a small browser/server performance scorecard and low-overhead
diagnostics. Use owner-local tests to iterate quickly on the responsible layer. Experiment on the
slowest measured journey, keep only changes that improve user-perceived metrics without weakening
advanced browser capabilities, and fold retained experiments into simple runtime paths.

## Directions Considered

| Direction                               | Why it is attractive                                                               | Why it is not enough                                                                                    | Decision                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Review-gate-first quality program       | Easy to enforce and already has infrastructure.                                    | It can make review notes better without making the product faster.                                      | Do not lead with this. Keep it as a downstream protection only.           |
| Microbenchmark-first optimization       | Fast iteration and good for isolating hot functions.                               | It does not prove browser-perceived responsiveness, focus, paint, websocket, or multi-context behavior. | Use only as a diagnostic after a product journey identifies a bottleneck. |
| Broad Playwright/browser matrix first   | Closest to user reality.                                                           | Too slow and noisy for rapid experimentation, especially on loaded machines.                            | Avoid as the main loop. Use narrow browser scorecard journeys.            |
| Backend/headless stress first           | Strong fit for PTY, websocket, replay, and control-plane pressure.                 | It misses renderer paint, focus, layout, iframe navigation, and remote/mobile UX.                       | Keep as a supporting layer, not the final claim.                          |
| Large rewrite for a faster architecture | Could remove accumulated complexity in one pass.                                   | High risk, delayed feedback, and likely to regress advanced browser capabilities.                       | Reject unless a measured bottleneck proves the current path is boxed in.  |
| Perceived-polish first                  | Can hide latency with optimistic UI and better loading states.                     | It risks masking stale truth or unclear control, which violates the product principles.                 | Use after canonical behavior is fast enough and owner truth is visible.   |
| Product scorecard plus targeted fixes   | Measures what users feel, keeps experiments bounded, and supports rapid iteration. | Requires instrumentation and disciplined baseline work before optimization.                             | Choose this as the primary path.                                          |

## Product Scorecard

The scorecard should measure product journeys, not implementation helpers. Budgets start
provisional and become hard only after a baseline on a reference machine.

| Journey                              | User frustration prevented                      | Primary metric                                    | Provisional budget                         | First bottleneck split                                                                 |
| ------------------------------------ | ----------------------------------------------- | ------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Cold browser/server launch           | "I opened it and waited before I could work."   | selected task and terminal become usable          | selected terminal usable within 1.5s       | server bootstrap, client state apply, terminal attach, first paint                     |
| Terminal typing under agent output   | "I typed and it lagged."                        | input-to-visible-echo p50, p95, p99               | p95 under 75ms on local reference load     | browser input, websocket send, server PTY write, output batching, terminal paint       |
| Task switch with terminal continuity | "I switched tasks and the terminal was stale."  | switch request to focused ready terminal          | useful within 250-400ms                    | selected-task projection, terminal retention, attach scheduling, focus handoff         |
| Review/diff open                     | "I lost trust in the diff or it froze the app." | request to first useful diff, then settled render | medium under 500ms, large under 1.5s       | git/diff fetch, diff shaping, Monaco load, syntax/decorations, visible-row rendering   |
| Preview through port exposure        | "The preview opened slowly or broke routing."   | expose/open request to navigable preview          | known port under 500ms, navigable under 1s | port observation, exposure state, proxy routing, iframe navigation, cookie/header work |
| Remote/mobile command session        | "A remote browser felt second-class or unsafe." | connect/takeover/type acknowledgment              | command acknowledgment under 300-500ms     | auth, bootstrap, peer presence, lease/takeover, websocket priority                     |
| Reconnect and replay                 | "It says reconnecting forever."                 | reconnect start to selected surface usable        | selected surface restored within 1s        | websocket auth, replay payload, state replacement, selected-surface scheduling         |
| Cleanup while surfaces are open      | "Deleted or stale tasks still looked alive."    | action to surfaces reflecting current truth       | visible cleanup within 500ms               | backend event, store replacement, panel projection, preview/review/terminal teardown   |

## Current Scorecard Baseline

The smoke scorecard baseline is captured with:

```bash
npm run perf:scorecard:smoke:baseline
```

Current smoke evidence comes from the latest post-change repeat artifact:
`artifacts/performance-scorecard/smoke/summary-2026-05-09T20-16-23-478Z.md`.

| Journey                                        | Metric                                               | p95      | Budget | Status |
| ---------------------------------------------- | ---------------------------------------------------- | -------- | ------ | ------ |
| browser session launch                         | navigation to selected terminal interactive          | 902.10ms | 1500ms | pass   |
| browser session launch                         | navigation to app shell painted                      | 568.70ms | 1200ms | pass   |
| browser session launch                         | app shell painted to selected terminal interactive   | 342.70ms | 600ms  | pass   |
| browser session launch                         | renderer cold-bootstrap selected-terminal tier       | 420.00ms | 500ms  | pass   |
| terminal typing under browser/server transport | end-to-end p95 sample max                            | 37.60ms  | 75ms   | pass   |
| task switch with terminal continuity           | sidebar click to target terminal interactive         | 8.40ms   | 400ms  | pass   |
| review diff open                               | open review and select unstaged to first useful diff | 132.80ms | 500ms  | pass   |
| cleanup while surfaces are open                | current-branch cleanup with review and preview open  | 394.30ms | 500ms  | pass   |
| reconnect and replay                           | reconnect request to selected terminal interactive   | 354.40ms | 1000ms | pass   |
| remote/mobile command session                  | remote shell navigation to command input visible     | 606.11ms | 1500ms | pass   |
| remote/mobile command session                  | remote takeover request to owner approval prompt     | 303.75ms | 500ms  | pass   |
| remote/mobile command session                  | owner approval to remote control available           | 61.33ms  | 500ms  | pass   |
| remote/mobile command session                  | remote send command to backend write acknowledgement | 66.83ms  | 500ms  | pass   |
| preview through explicit port exposure         | expose request to navigable preview                  | 72.53ms  | 1000ms | pass   |

Treat this as promising browser-scorecard evidence, not product-goal completion proof. It directly
improves the earlier selected-terminal startup miss by prebinding the browser output channel while
the lazy terminal-session module loads. It also adds smoke coverage for current-branch cleanup,
selected-surface reconnect, mobile remote-shell takeover, backend write acknowledgement, and
scrollback confirmation.

It still does not prove reconnect under heavier replay/load, long-lived multi-client coordination,
managed-worktree cleanup, or loaded multi-agent behavior.

Historical scorecard context:

- `artifacts/performance-scorecard/smoke/summary-2026-05-09T14-17-33-603Z.md` exposed the cold
  selected-terminal miss that drove the output-channel prebind work: selected terminal was 1547.20ms
  against a 1500ms budget, app-shell-to-terminal readiness was 621.90ms against 600ms, and the
  renderer selected-terminal tier was 724.00ms against 500ms.
- `artifacts/performance-scorecard/smoke/summary-2026-05-09T14-11-20-231Z.md` was a loaded
  no-rebuild rerun where unrelated startup and preview spans regressed together and renderer
  diagnostics recorded long tasks with p95 1182ms. Treat that as evidence that local Playwright
  timing is load-sensitive, not as a standalone product regression or a reason to weaken budgets.
- `artifacts/performance-scorecard/smoke/summary-2026-05-09T18-42-07-378Z.md` showed the
  terminal-session module load as a material startup segment: selected terminal interactive was
  1040.00ms, terminal-session module load was 210.30ms, and module-loaded-to-selected-interactive
  was 214.30ms. An immediate browser/server preload experiment was rejected because it did not
  improve selected-terminal readiness and regressed the renderer tier to 558.00ms in
  `summary-2026-05-09T18-44-33-597Z.md`.
- `artifacts/performance-scorecard/smoke/summary-2026-05-09T18-58-01-868Z.md` split selected
  attach after module load and pointed the bottleneck at output-channel readiness and module load,
  not terminal fit or spawn.

Loaded multi-agent evidence is weaker. `npm run profile:terminal:ui-fluidity:gate` completed and
wrote `artifacts/terminal-ui-fluidity/2026-05-09T20-18-14-789Z/summary.md`, but that run predates
explicit budget observations in the matrix artifact, so its exit code only proves the profiler
completed. It should not be cited as a pass.

Applying the current provisional UI-fluidity observations to that artifact would mark it
`provisional-fail`: 60 of 90 measured checks exceed their current budget. Those budgets are for
triage in loaded browser product work; they do not replace runtime improvements.

The loaded matrix did expose the next likely product bottleneck:

- `product_default` keeps hidden output suppressed and hidden queue age low, but
  `interactive_verbose` at 2 and 4 visible terminals still had p95 round trips of 1825.20ms and
  1868.30ms, frame-gap p95 of 283.30ms and 300.00ms, and long-task totals of 8248ms and 6248ms.
- `high_load_mode_product` improves some dense interactive round-trip medians, but it is not a clean
  promotion candidate: at 1 visible terminal, `recent_hidden_switch` showed frame-gap p95 316.70ms,
  round trip 1973.50ms, render p95 15728.90ms, and hidden queue p95 15006.00ms.
- Across the retained loaded run, `high_load_mode_product` often had `suppressed=0` and hidden queue
  p95 from about 5325ms to 15006ms, while `product_default` traded much lower hidden queue age for
  poor focused round trips in multi-visible interactive output.

New UI-fluidity matrix artifacts include provisional budget observations and support
`--fail-on-budget` for branches explicitly trying to satisfy this loaded browser lane. Keep the
default profiler as an evidence generator, not a PR-first gate. The next product-code pass should
target terminal output scheduling under `interactive_verbose` with 2 and 4 visible terminals and
hidden-switch wake behavior under 1 visible terminal, then confirm the retained path with a fresh
repeated matrix and the smoke scorecard.

The 2026-05-10 first retained loaded-lane change tightens the shipped High Load Mode profile for
sparse hidden switches:

- it preserves the default hidden-terminal render hibernation policy instead of accidentally
  disabling hidden-output suppression when the built-in High Load Mode config is active
- it adds a bounded switch echo grace reservation for 1 and 2 visible terminals, then renews the
  1.5s active window when the first local input arrives
- it caps focused writes during that sparse switch reservation at 8KiB, then completes the grace
  when the focused backlog drains so user echo is not buried behind restored backlog

The narrow browser comparison for the worst loaded lane used 24 terminals, `recent_hidden_switch`,
one requested visible terminal, and a 3s measurement window. The first hibernation-only attempt
confirmed hidden suppression but failed user-visible switching:
`artifacts/terminal-ui-fluidity/2026-05-10-high-load-hidden-hibernation-check/summary.md` had
frame-gap p95 6833.10ms, long-task total 23210ms, and no completed hidden-switch round trip. A
same-machine `product_default` comparison at
`artifacts/terminal-ui-fluidity/2026-05-10-product-default-hidden-switch-check/summary.md` completed
the round trip but was still poor: frame-gap p95 649.80ms, long-task total 8748ms, and hidden-switch
round trip 4397.90ms. After adding sparse switch echo grace and the first-write cap,
`artifacts/terminal-ui-fluidity/2026-05-10-high-load-hidden-switch-echo-check/summary.md` improved
the same lane to frame-gap p95 100.10ms, long-task total 1680ms, hidden-switch round trip 553.40ms,
terminal render p95 1943.80ms, focused queue p95 136.40ms, hidden queue p95 0ms, and post-input
echo delay 53.30ms.

The 2026-05-10 second retained loaded-lane change extends High Load Mode pressure response to the
2-visible interactive layout:

- it keeps the hidden hibernation and sparse switch echo protections above
- it applies exact 2-visible frame-pressure scaling for non-target visible frame budget and
  visible-background write batches
- it applies the existing focused pressure boost at 2 visible terminals, matching the already
  retained 4-visible pressure behavior

The narrow interactive comparison remains incomplete but moved the next bottleneck. Before the
2-visible pressure change,
`artifacts/terminal-ui-fluidity/2026-05-10-high-load-interactive-verbose-mini/summary.md` showed the
2-visible `interactive_verbose` lane at frame-gap p95 283.30ms, long-task total 3990ms, terminal
render p95 5471.40ms, and focused round trip 1773.40ms; 4-visible was closer but still missed
focused round trip at 599.40ms. A direct non-target visible candidate-limit experiment was rejected:
`artifacts/terminal-ui-fluidity/2026-05-10-high-load-interactive-verbose-candidate-limit-check/summary.md`
improved 2-visible frame gaps but worsened 4-visible frame-gap and round-trip behavior, so that
policy was not retained. After the pressure change,
`artifacts/terminal-ui-fluidity/2026-05-10-high-load-interactive-verbose-pressure-check/summary.md`
showed 2-visible frame-gap p95 100.10ms, long-task total 3732ms, terminal render p95 4670.70ms, and
focused round trip 733.80ms; 4-visible showed frame-gap p95 133.30ms, long-task total 3448ms,
terminal render p95 4802.90ms, and focused round trip 693.60ms.

A direct sustained-input coalescing experiment was rejected after the sharper diagnostics split
showed it moved pressure to the input send path instead of improving perceived latency. The
experiment kept the first idle key immediate but batched follow-on interactive input with a 1ms
window and four-character cap. In
`artifacts/terminal-ui-fluidity/2026-05-10-input-coalescing-check/summary.md`, 2-visible
`interactive_verbose` regressed to frame-gap p95 649.90ms, long-task total 9754ms, terminal render
p95 7273.90ms, and focused round trip 4291.40ms; the per-run diagnostics showed input sent p95
2669.90ms. The 4-visible leg passed frame-gap and long-task budgets but still regressed focused
round trip to 2627.90ms. Do not revive this batching shape without a different design that proves
input send acknowledgement and visible echo both improve.

The next measurement pass found a proof-quality issue: the profiler could request a
visible-terminal count but still run against a different app-reported layout after viewport
settling. That made exact visible-count tuning less reliable than the artifact labels implied. The
profiler now aligns the viewport to the app-reported visible-terminal count before the workload
starts and fails if it cannot satisfy the requested count. With that correction, the current
High Load Mode `interactive_verbose` evidence is:

- `artifacts/terminal-ui-fluidity/2026-05-10-visible-count-alignment-check/summary.md` confirmed an
  actual 2-visible layout at 24 terminals: frame-gap p95 116.60ms, long-task total 3269ms, focused
  round trip 645.70ms, terminal render p95 2368.10ms, input buffered p95 80.40ms, input sent p95
  386.60ms, hidden queue p95 0ms, and hidden suppression 3834177 bytes.
- `artifacts/terminal-ui-fluidity/2026-05-10-visible-count-alignment-check-visible4/summary.md`
  confirmed an actual 4-visible layout at 24 terminals: frame-gap p95 116.70ms, long-task total
  3016ms, focused round trip 632.60ms, terminal render p95 4193.50ms, input buffered p95 104.50ms,
  input sent p95 338.40ms, hidden queue p95 0ms, and hidden suppression 2816388 bytes.

This changes the next optimization target. Exact 2- and 4-visible High Load Mode now pass the frame,
render, and hidden-queue shape on the narrow `interactive_verbose` check. The remaining misses are
focused round trip by about 130-150ms and long-task tail by about 16-269ms. The next experiment
should inspect command acknowledgement, PTY write acknowledgement, websocket/control message
priority, flow-control windows, and focused echo measurement semantics before making more
output-scheduling changes.

A focused round-trip split was added after that check to separate long-marker keyboard dispatch from
echo-after-dispatch time. The narrow three-repeat run at
`artifacts/terminal-ui-fluidity/2026-05-10-focused-roundtrip-split-repeat3/` confirmed that this lane
is noisy enough to require repeated evidence and timeout accounting: repeat 1 had round-trip p95
302.50ms, input-dispatch p95 283.40ms, and echo-after-dispatch p95 47.60ms; repeat 2 timed out one
probe and had frame-gap p95 283.30ms; repeat 3 had round-trip p95 1169.90ms, input-dispatch p95
485.50ms, and echo-after-dispatch p95 1037.70ms. The matrix/gate reporting now treats timeout
counts as explicit failures and filters negative timeout sentinels out of latency medians, so loaded
browser evidence cannot look better because a repeat timed out.

A targeted Chromium trace at
`artifacts/terminal-ui-fluidity/2026-05-10-interactive-verbose-trace-check/` kept the same exact
2-visible `interactive_verbose` shape and showed the long-task tail is mostly browser commit work,
not renderer scheduler bookkeeping. Runtime owner p95 was 0.50ms, scheduler drain p95 was 0.40ms,
and trace long tasks were dominated by `Commit` slices. Treat that as a pointer toward rendered
terminal write pressure, browser commit cost, or trace-amplified rendering work before changing
store projection or scheduler scan code.

A direct focused-pressure-neutral experiment was rejected:
`artifacts/terminal-ui-fluidity/2026-05-10-focused-pressure-neutral-check/summary.md` reduced
the focused dense-pressure scale back to the neutral visible-terminal scale. It improved long-task
total to 2695ms, but regressed the product-visible path: frame-gap p95 was 216.70ms, focused round
trip p95 was 1152.80ms, terminal render p95 was 3110.40ms, input sent p95 was 612.70ms, and
flow-control paused eight times with zero resumes. Do not remove the focused pressure boost as the
next simplification; the evidence says it protects frame and echo responsiveness even though it does
not close the remaining browser commit cost.

The fresh retained loaded matrix at
`artifacts/terminal-ui-fluidity/2026-05-10-retained-loaded-matrix-repeat3/summary.md` failed 21 of
51 provisional checks across `recent_hidden_switch`, `interactive_verbose`, and `bulk_text` for
1, 2, and 4 visible terminals. The median failing shape is broader than one constant: 2-visible
`interactive_verbose` still missed focused round trip at 642.40ms and long-task total at 4522ms,
4-visible `recent_hidden_switch` missed focused round trip at 2091.10ms, and bulk text missed
frame, long-task, and render budgets at 2 and 4 visible terminals.

Two follow-up product-code candidates were rejected and backed out:

- `artifacts/terminal-ui-fluidity/2026-05-10-trace-backed-echo-completion-check/summary.md` and
  `artifacts/terminal-ui-fluidity/2026-05-10-gated-trace-echo-completion-check/summary.md` tried to
  tie focused-input echo reservation completion to matched input trace rendering. Both worsened the
  2-visible `interactive_verbose` path; the gated version still had frame-gap p95 233.30ms,
  long-task total 5944ms, and focused round trip 1582.30ms.
- `artifacts/terminal-ui-fluidity/2026-05-10-interactive-echo-write-slice-check/summary.md` tried a
  4KiB focused write-slice cap during the interactive echo fast path. It produced one good
  round-trip repeat but regressed the tail; the summary had frame-gap p95 316.70ms, long-task total
  5953ms, and focused round trip 3694.80ms.

The next diagnostics pass split terminal input acknowledgement into buffered-to-dispatched and
dispatched-to-accepted timing. The narrow browser smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-input-ack-split-smoke/summary.md` verified the split in
real browser output: 2-visible `interactive_verbose` had frame-gap p95 83.40ms, long-task total
2575ms, focused round trip 524.50ms, input dispatched p95 118.30ms, and input accepted p95
167.90ms. Treat this as diagnostic validation, not a product pass. It shows the old combined
input-sent number needs to be split before the next product-code change.

The repeated split run at
`artifacts/terminal-ui-fluidity/2026-05-10-input-ack-split-repeat3/summary.md` confirmed that the
bad tail is spread across stages. 2-visible `interactive_verbose` failed frame-gap p95 at 183.30ms,
long tasks at 5924ms, terminal render p95 at 6216.10ms, and focused round trip at 1065.30ms, with
input-dispatch p95 384.10ms, echo-after-dispatch p95 737.80ms, terminal-input dispatched p95
361.10ms, and accepted p95 324.50ms. A narrower in-flight interactive batching experiment was then
rejected and backed out after
`artifacts/terminal-ui-fluidity/2026-05-10-in-flight-interactive-batch-check/summary.md` still
failed frame-gap, long-task, and focused-roundtrip budgets; repeat 2 exposed the unacceptable tail
directly with focused round trip 4505.40ms, input-dispatch p95 1765.40ms, and echo-after-dispatch
p95 2740.00ms. Do not batch interactive input behind an in-flight send as the next product path.

The backend input trace is now included in the UI-fluidity profiler and matrix summaries. The
validation smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-backend-input-trace-smoke/summary.md` failed the loaded
2-visible `interactive_verbose` frame and focused-roundtrip budgets, but narrowed the owner split:
server queue p95 was 0.25ms, PTY input max queue was one char, control backpressure/send errors were
zero, transport residual p95 was 209.75ms, backend-observed render p95 was 234.90ms, and terminal
render p95 was 3743.80ms. That makes PTY write/queue policy a weak next target for this lane; the
next runtime experiment should target rendered terminal commit pressure, output priority during
focused input, or transport-to-render residual before changing backend input batching.

A direct High Load Mode focused-preemption-window experiment was rejected and backed out. Extending
the focused preemption window from 150ms to 400ms looked plausible because echo and render often
arrived after the old window, but the repeated artifact at
`artifacts/terminal-ui-fluidity/2026-05-10-high-load-focused-preemption-400-check/summary.md`
regressed the 2-visible `interactive_verbose` lane: frame-gap p95 was 200.00ms, long-task total was
5982ms, terminal render p95 was 5857.10ms, and focused round trip was 928.20ms. Keep the existing
150ms window unless a later diagnostic proves a narrower, owner-specific preemption rule.

The UI-fluidity lane now keeps expensive terminal visible-line snapshots out of the default
performance profiler while preserving them for browser render/restore diagnostics that explicitly
need line-level assertions. The repeated check at
`artifacts/terminal-ui-fluidity/2026-05-10-visible-line-diagnostics-opt-in-check/summary.md`
reduced the measured terminal-render p95 to 1260.50ms, but still failed long-task total at 5639ms
and focused round trip at 633.70ms. Treat this as retained measurement-fidelity work, not a loaded
product pass.

The profiler also now reports focused-input output priority splits. The smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-focused-input-output-split-smoke/summary.md` showed the
new line in real browser output: focused-input focused bytes p95 was 6463, active-visible bytes p95
was 0, visible-background bytes p95 was 64, direct calls p95 was 0, queued calls p95 was 2,
visible-background queue age p95 was 154.40ms, and queued queue age p95 was 154.40ms. This makes a
broad active-visible or direct-write suppression experiment less compelling for the focused-input
window; the remaining tail still points to keyboard dispatch, command acknowledgement,
transport-to-render split quality, and browser commit work.

The backend input trace now also splits the old transport residual into PTY echo,
backend-output-buffer, and browser-delivery stages when the input echo can be matched cheaply. The
validation smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-backend-output-split-final-smoke/summary.md`
deliberately used the same loaded 2-visible `interactive_verbose` lane and still failed provisional
budgets: frame-gap p95 was 250.00ms, long-task total was 3174ms, focused round trip was 911.60ms,
and terminal render p95 was 2708.50ms. The split is useful because it narrows what not to chase
next: server queue p95 was 0.20ms, PTY echo p95 was 92.51ms, backend output buffer p95 was 0.03ms,
and browser delivery p95 was 66.46ms, while client-send p95 was 288.90ms, renderer-observed render
p95 was 497.10ms, focused round-trip split was 165.00ms input-dispatch plus 746.60ms
echo-after-dispatch, and visible-background queue age during focused input was 2460.90ms. Treat
this as retained measurement fidelity, not a product pass. It weakens PTY queue/write and backend
output buffering as likely next bottlenecks for this lane; the remaining product-code work should
focus on client-side dispatch/acknowledgement under load, websocket/control priority, flow-control
recovery, rendered terminal commit pressure, and visible-background backlog interaction during
focused input.

The narrow visible-background suppression follow-up is retained only as a bounded
typing-critical guard, not as a completed loaded-lane fix. It blocks new visible-background drains
after the focused echo completes while typing-critical input is still active, and owner-local
scheduler coverage now protects that invariant. The single smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-typing-critical-visible-background-block-smoke/summary.md`
passed the loaded 2-visible `interactive_verbose` budgets with frame-gap p95 133.30ms, long-task
total 2979ms, focused round trip 416.90ms, and focused-input visible-background bytes p95 0. The
three-repeat confirmation at
`artifacts/terminal-ui-fluidity/2026-05-10-typing-critical-visible-background-block-repeat3/summary.md`
was still a provisional failure: long tasks were 3115ms and focused round trip was 754.80ms. It
reduced focused-input visible-background output in two of three repeats, but repeat 2 still exposed
an in-flight visible-background queue-age outlier of 4512.40ms and a focused round trip of
1886.50ms. The useful conclusion is narrower than "output scheduling solved it": blocking new
visible-background drains is correct user-priority behavior, while the remaining tail likely lives
in in-flight visible-background writes, browser commit pressure, and client dispatch/echo
coordination under load.

Terminal write-duration diagnostics are now emitted in UI-fluidity profiler and matrix summaries.
The first narrow smoke with that split at
`artifacts/terminal-ui-fluidity/2026-05-10-terminal-write-duration-diagnostic-smoke/summary.md`
still failed the loaded 2-visible `interactive_verbose` provisional budgets: long tasks were
4014ms and focused round trip was 997.30ms. The useful split is that total write-duration p95 was
168.80ms and visible-background write-duration p95 was 89.80ms overall, while focused-input
visible-background bytes and visible-background write-duration were both 0. In this sample, the
focused-input miss therefore did not come from visible-background writes executing inside the
focused-input window; it pointed back to input dispatch p95 549.20ms, accepted p95 347.80ms,
browser delivery p95 237.08ms, and focused write-duration p95 75.40ms during focused input.

A narrower 2-visible visible-background write-slice experiment was rejected and backed out. Dropping
the exact 2-visible High Load Mode critical visible-background write slice from 1024B to 512B looked
promising in the first smoke
(`artifacts/terminal-ui-fluidity/2026-05-10-few-visible-background-write-512-smoke/summary.md`),
but the three-repeat confirmation at
`artifacts/terminal-ui-fluidity/2026-05-10-few-visible-background-write-512-repeat3/summary.md`
still failed the loaded lane: long tasks were 4458ms and focused round trip was 673.10ms. The
aggregate also showed focused-input visible-background writes reappearing at 512B with
focused-input visible-background write-duration p95 221.10ms. Keep the retained 1024B critical
slice unless a sharper diagnostic proves smaller chunks reduce browser commit pressure without
increasing focused-input write churn.

The next retained diagnostic closes that proof gap by sampling active terminal writes per frame.
Completion-duration summaries only report writes when their callback fires. The active-write gauge
reports count and max age while a write is still pending, including focused-input frames. Use the
next loaded artifact to decide whether the remaining tail comes from writes already in flight when
typing begins or from later keyboard dispatch/browser commit pressure.

The first active-write diagnostic smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-active-write-diagnostic-smoke/summary.md` still failed
the loaded 2-visible `interactive_verbose` budgets with long tasks at 3435ms and focused round trip
at 721.90ms. It proved the new split is useful: focused-input visible-background bytes stayed 0, but
focused-input active visible-background write age was 448.10ms p95. A broad typing-critical-window
experiment was then rejected and backed out. Extending the typing-critical window from 240ms to
900ms in `artifacts/terminal-ui-fluidity/2026-05-10-typing-critical-900-smoke/summary.md`
worsened the lane to frame-gap p95 283.40ms, long tasks 6712ms, terminal render p95 5724.90ms, and
focused round trip 2337.80ms with flow-control pauses. Do not solve the in-flight write problem by
broadly stretching global typing-critical state.

A scheduler-level visible-background in-flight admission guard was also rejected and backed out.
The experiment treated the existing visible-background candidate limit as an in-flight write limit,
so a second visible-background terminal could not start a scheduler-drained write while another
visible-background write callback was pending. The single smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-visible-background-inflight-limit-smoke/summary.md`
looked promising for focused input: focused round trip was 487.10ms and focused-input active
visible-background write age was 0, but long tasks still missed at 3137ms. The three-repeat
confirmation at
`artifacts/terminal-ui-fluidity/2026-05-10-visible-background-inflight-limit-repeat3/summary.md`
failed with long tasks at 3178ms, one focused-roundtrip timeout, and focused round trip p95
526.25ms; repeat 2 exposed the real tail with frame-gap p95 499.90ms, long tasks 10727ms, and a
round-trip timeout. The aggregate still showed focused-input active write count p95 2 and active
visible-background write age p95 137.30ms. Do not revive this scheduler-only concurrency guard
without a sharper design that also explains direct/queued write admission and browser commit
pressure under focused input.

An early local-input intent experiment was rejected and backed out. The experiment moved the
existing typing-critical marker from input-send time to the moment xterm emitted non-paste local
input, so background visible output would see focused-input pressure before lease reacquire,
buffering, and websocket send. The single smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-early-input-intent-smoke/summary.md` passed all
provisional checks with frame-gap p95 100.00ms, long tasks 2457ms, and focused round trip 463.10ms,
but it still showed focused-input visible-background bytes p95 1024 and active visible-background
write age p95 182.70ms. The three-repeat confirmation at
`artifacts/terminal-ui-fluidity/2026-05-10-early-input-intent-repeat3/summary.md` failed with long
tasks 3272ms and focused round trip 538.50ms; repeat 2 had frame-gap p95 266.60ms, long tasks
4869ms, and focused round trip 2095.20ms. Do not move the typing-critical marker earlier by itself;
it can improve one smoke while leaving pre-existing background write/commit pressure and the
focused round-trip tail unsolved.

A passive-visible render hibernation experiment was rejected and backed out. The experiment kept
the selected/focused terminal live but temporarily hibernated visible sibling renderers during
High Load Mode focused input, using the existing render-hibernation path instead of scheduler
admission changes. The three-repeat smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-passive-visible-hibernate-smoke/summary.md` reduced
focused-input visible-background bytes to 0 in the aggregate and improved focused round trip versus
the earlier retained repeat, but it still failed with long tasks at 4317ms and focused round trip
p95 554.80ms; repeat 2 exposed frame-gap p95 266.70ms and focused round trip 1733.90ms. It also
raised suppressed visible output to 1721808 bytes. Do not freeze passive visible sibling render as
the next retained fix without a stronger design that reduces browser commit long tasks and avoids a
large stale-visible-output tradeoff.

The next retained diagnostic splits input dispatch again by measuring task-command lease wait
separately from buffered-to-dispatched and dispatched-to-accepted timing. This is product-relevant
because the loaded artifacts show high input-dispatch/client-send tails while backend server queue,
PTY echo, and backend output buffering are usually cheap. The next loaded artifact should report
`terminal-input-split lease-wait-p95` so we can decide whether the remaining first-key and focused
round-trip misses belong to task-command ownership/control transport or to later browser
delivery/render commit work.

The first browser smoke with the lease-wait split at
`artifacts/terminal-ui-fluidity/2026-05-10-input-lease-wait-diagnostic-smoke/summary.md` failed the
loaded 2-visible `interactive_verbose` lane with frame-gap p95 183.40ms, long tasks 7063ms,
terminal render p95 5474.20ms, and focused round trip 1074.80ms. The new split is decisive enough
for the next decision: task-command lease wait p95 was only 0.10ms and max was 1.50ms, while
dispatched p95 was 241.70ms, accepted p95 was 348.30ms, browser delivery p95 was 243.39ms,
focused-input write-duration p95 was 318.00ms, and focused-input active visible-background write
age p95 was 386.10ms. Do not spend the next product pass on task-command lease acquisition; the
slow path is later client send/browser delivery/rendered write commit and in-flight visible output
pressure.

The next retained diagnostic now splits focused-input active visible-background writes by whether
the write started before the focused-input window or started during it. The first narrow browser
smoke with that split at
`artifacts/terminal-ui-fluidity/2026-05-10-active-write-start-boundary-smoke/summary.md` still
failed the loaded 2-visible `interactive_verbose` lane on long tasks at 4399ms, but confirmed the
split is actionable: focused round trip was 471.30ms, frame-gap p95 was 83.40ms, and focused-input
visible-background active write p95 was one write at 183.10ms that started before focused input;
started-during-input visible-background active writes were 0. Treat this as measurement fidelity,
not loaded-goal completion. In this sample, the next product-code target is pre-existing in-flight
browser commit pressure rather than new visible-background write admission during typing-critical
input.

A direct visible-background continuation-delay experiment was rejected and backed out. The
experiment inserted a 16ms delay before continuing visible-background writes under High Load Mode
frame pressure. In
`artifacts/terminal-ui-fluidity/2026-05-10-visible-background-continuation-delay-smoke/summary.md`,
the same loaded 2-visible `interactive_verbose` lane regressed: long tasks rose to 5067ms, focused
round trip missed at 608.80ms, terminal render p95 rose to 2017.40ms, and the pre-existing
visible-background active write age grew to 287.40ms while started-during-input active writes
remained 0. Do not revive a fixed continuation delay unless a sharper design proves it reduces
browser commit pressure without aging already-active writes.

The next retained diagnostic extends the active-write start-boundary split with active-write bytes.
The rebuilt browser smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-active-write-byte-split-smoke-rebuilt/summary.md`
recorded the split in the same loaded 2-visible `interactive_verbose` lane. The lane still failed
long tasks at 4679ms and focused round trip at 704.40ms, but the active-write evidence is sharper:
focused-input visible-background writes that started before input were one 556B write aging to
130.30ms, and started-during-input visible-background writes were 0B/0 writes. Backend splits were
still comparatively cheap: server queue p95 0.12ms, PTY echo p95 31.75ms, backend output buffer p95
0.03ms, and browser delivery p95 22.95ms, while terminal input sent p95 was 314.50ms and accepted
p95 was 279.40ms. Do not spend the next pass on another visible-background write-size cap alone;
the measured tail is small-write callback/commit aging plus input dispatch/acknowledgement under
browser pressure.

The browser-control diagnostics now also record websocket `bufferedAmount` high-water in profiler
and matrix summaries. The first rebuilt smoke with that split at
`artifacts/terminal-ui-fluidity/2026-05-10-browser-control-buffered-smoke/summary.md` failed the
same loaded 2-visible `interactive_verbose` lane more severely: frame-gap p95 300.00ms, long tasks
9409ms, terminal render p95 8114.80ms, and focused round trip 1996.30ms. The negative evidence is
still useful because browser-control `control-buffered-max` was 0 with zero control backpressure,
not-open, send-error, or delayed-queue bytes. Do not spend the next pass on hidden browser-control
websocket bufferedAmount pressure; this sample points back to client dispatch, browser delivery,
rendered terminal commit work, and small in-flight visible-background write aging under browser
pressure.

A direct interactive input in-flight window experiment was rejected and backed out. The raw
browser-control-buffered artifact already showed renderer input queue saturation
(`inFlightBatchesMax=16`, `queuedChunksMax=39`), so the experiment raised the interactive/control
input in-flight cap while leaving burst and paste input at the existing generic cap. The single
smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-interactive-input-concurrency-check/summary.md` proved
the local dispatch hypothesis but not a product win: dispatched p95 dropped to 0.20ms and
client-send p95 dropped to 0.20ms with `renderer-terminal-input in-flight-max=39`, but the lane
still failed frame-gap p95 183.40ms, long tasks 6698ms, terminal render p95 5492.90ms, and focused
round trip 2061.20ms. Do not increase the interactive in-flight cap by itself; it shifts the tail
to echo-after-dispatch, PTY echo, browser delivery, and rendered commit pressure without closing the
user-visible round trip.

The next retained diagnostic separates browser-client websocket send buffering from the earlier
backend browser-control bufferedAmount signal. The narrow smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-browser-client-buffered-smoke/summary.md` still failed
the loaded 2-visible `interactive_verbose` lane on long tasks at 4716ms, but frame-gap p95 was
83.40ms, focused round trip p95 was 473.90ms, and terminal render p95 was 963.90ms. The new split
showed `browser-control-client sends=216`, `nonzero-buffered-sends=112`, and `buffered-max=7298`,
while backend `control-buffered-max` remained 0. Treat this as evidence that client-side control
send pressure can coexist with the loaded tail even when the server-side control socket is not
buffered. It is not enough to justify a broad send-window increase, because the previous in-flight
cap experiment improved local dispatch while worsening user-visible echo. The next product-code
experiment should therefore target browser-client command pacing or priority with explicit terminal
input acknowledgement and render-commit proof, not raw concurrency.

The follow-up by-type browser-client buffering smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-browser-client-buffered-by-type-smoke/summary.md`
made that diagnostic more actionable and reproduced the bad tail: frame-gap p95 was 233.30ms, long
tasks were 6929ms, terminal render p95 was 6793.50ms, and focused round trip was 1224.30ms. The
client-side buffered send split was concentrated in input and resume traffic, not resize:
`input-sends=78`, `input-nonzero-buffered=32`, `input-buffered-max=7295`, `resume-sends=24`,
`resume-nonzero-buffered=22`, and `resume-buffered-max=7171`, while resize sends stayed at 0 and
backend `control-buffered-max` stayed 0. This keeps browser-client input/resume pacing and
flow-control recovery in scope, but it rules out resize/control-plane buffering as the immediate
target for this lane.

Two direct flow-control low-watermark experiments were then rejected and backed out. Raising
`FLOW_LOW` from 32KiB to 128KiB in
`artifacts/terminal-ui-fluidity/2026-05-10-flow-low-128-smoke/summary.md` improved some
single-run user-visible metrics, including focused round trip at 499.50ms and terminal render p95
at 882.50ms, but still failed long tasks at 5652ms and caused heavy resume churn
(`resume-sends=60`, `resume-nonzero-buffered=30`) with visible-background output still appearing
during focused input. A more conservative 64KiB smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-flow-low-64-smoke/summary.md` also failed the lane with
long tasks at 4301ms and focused round trip at 615.40ms. Keep the original 32KiB low watermark
until a narrower design proves that resume pacing improves acknowledgement and browser commit cost
without adding resume churn or stale-output tradeoffs.

A duplicate flow-control resume settle-window experiment was also rejected and backed out. It kept
the resume request in a short pending state after the local websocket send succeeded, so repeated
input/idle recovery could not spam duplicate resume commands while the browser/server path caught
up. The single smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-flow-resume-settle-smoke/summary.md` proved the narrow
mechanical effect, reducing resume sends to 5 with zero nonzero-buffered resume sends, but it still
missed the loaded lane: long tasks were 4287ms and focused round trip was 672.90ms. Do not keep a
resume-chatter reduction by itself unless it also improves the user-visible round trip. The next
flow-control experiment should be more explicit about backend acknowledgement or priority rather
than only coalescing duplicate resumes.

An explicit backend-acknowledged flow-control pause/resume experiment was then rejected and backed
out. It made browser flow-control `pause` and `resume` commands request-tracked and waited for
`agent-command-result` before settling the renderer-side IPC promise. The owner-local protocol, IPC,
server websocket, and command-result tests passed, but the narrow browser smoke regressed the same
loaded 2-visible `interactive_verbose` lane:
`artifacts/terminal-ui-fluidity/2026-05-10-flow-control-ack-smoke/summary.md` had frame-gap p95
300.00ms, long-task total 5143ms, terminal render p95 6682.20ms, and focused round trip p95
1973.90ms. The artifact also showed input sent p95 1082.70ms, accepted p95 931.10ms, eight pauses,
and zero resumes. Do not make flow-control pause/resume request-tracked on the hot path by itself;
it worsens the user-visible lane and can trap the renderer in pause-heavy recovery without closing
the acknowledgement/render tail.

A focused-input flow-control recovery-window experiment was also rejected and backed out. It kept
pause/resume untracked, but briefly resumed a paused focused channel on interactive input when the
queue was idle and the watermark was still above the normal resume threshold. The narrow browser
smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-focused-input-flow-recovery-smoke/summary.md` missed the
same loaded 2-visible `interactive_verbose` lane: frame-gap p95 was 283.40ms, long-task total was
5344ms, terminal render p95 was 5274.80ms, and focused round trip p95 was 590.00ms. The mechanism
did raise resumes to 16, but 14 resume sends had nonzero client-side buffering and the lane still
missed user-visible budgets. Do not add an input-coupled resume escape hatch by itself; resume count
improvement is not useful unless it also reduces browser commit pressure and focused echo latency.

A browser `isInputPending` visible-background admission guard was rejected and backed out. It
deferred starting 2-visible High Load Mode `visible-background` drains for a frame when Chromium
reported pending input. The smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-pending-input-visible-background-guard-smoke/summary.md`
passed the frame-gap budget at 116.70ms, but missed the product-visible lane with long-task total
7183ms and focused round trip 876.00ms. The artifact still showed a pre-existing 1024B
visible-background write aging to 276.80ms during focused input, while input dispatched p95 rose to
486.70ms and accepted p95 to 535.10ms. Do not add a browser-input-pending visible-background guard
by itself; it can avoid new starts without solving already-active commit pressure or input
acknowledgement.

The next retained diagnostic splits terminal command-result acknowledgement on both sides of the
browser/server boundary. Renderer-side terminal input summaries now report command-result receive
time and promise-settle overhead, while backend input traces report command-result send time and
PTY-write-to-command-ack timing. The narrow smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-command-result-ack-split-smoke/summary.md` verified the
new split in real browser output. It is not a loaded-lane pass: frame-gap p95 was 83.40ms and
long-task total was 2633ms, but focused round trip still missed at 604.40ms. The split is useful
negative evidence: backend command-ack p95 was 0.21ms and PTY-write-to-command-ack p95 was 0.09ms,
while renderer command-result receive p95 and accepted p95 were both 286.10ms, accepted-settle p95
was 0ms, browser delivery p95 was 129.62ms, and client-send p95 was 233.60ms. Do not spend the next
pass on backend command-result generation or promise-settle overhead; focus on browser-client
send/buffering, browser delivery, and rendered terminal commit pressure under load.

The browser-client send diagnostic now also records synchronous websocket send duration and
post-send buffered amount by message type. The narrow smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-browser-client-send-duration-smoke/summary.md` verified
the new fields in real browser output. It still missed the loaded lane, with long-task total 3287ms
and focused round trip 762.80ms, but it ruled out local JSON/stringify/socket-send duration as the
main culprit: overall send-duration p95, input send-duration p95, and resume send-duration p95 were
all 0.10ms. The same artifact still showed client-side buffering and downstream delivery pressure:
post-send buffered max was 6226 bytes, input post-send buffered max was 6226 bytes, resume post-send
buffered max was 5871 bytes, browser delivery p95 was 331.42ms, and backend browser-control
buffered max remained 0. Do not target synchronous renderer send duration next; target client-side
control-message pacing/priority, browser delivery, flow-control resume churn, and rendered commit
pressure.

The browser delivery diagnostic now splits the old backend-to-terminal-handler delivery span into
browser transport delivery and channel dispatch. The narrow smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-browser-transport-receive-split-smoke/summary.md`
verified the new fields in real browser output. It still missed the loaded lane: focused round trip
was 867.10ms and terminal render p95 was 2828.10ms, while frame-gap p95 was 133.30ms and long-task
total was 2837ms. The split is decisive negative evidence against terminal-session channel dispatch
overhead as the next target: browser delivery p95 was 248.43ms, browser transport delivery p95 was
also 248.43ms, and browser channel dispatch p95 was only 0.10ms. Do not spend the next pass on
terminal channel payload dispatch or message listener overhead; target browser event-loop delivery
before the channel callback, input dispatch under browser pressure, flow-control pacing, and rendered
commit pressure.

Focused round-trip diagnostics now also split echo received by the terminal handler from echo
rendered by the xterm write callback. The narrow browser smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-focused-rendered-probe-split-smoke/summary.md` verified
the new fields in real browser output. It did not close the loaded lane: focused round trip was
512.10ms, rendered round trip was 596.30ms, frame-gap p95 was 83.40ms, long-task total was 2355ms,
and terminal render p95 was 650.20ms. The split is useful because the render-after-receive portion
was 84.20ms, while input dispatch p95 was 328.70ms, browser transport delivery p95 was 209.40ms,
browser channel dispatch p95 was 0ms, and backend command/PTY/output buffering stayed cheap. Do not
turn the next pass into a terminal-session dispatch rewrite. The sharper target is keyboard
dispatch under browser pressure, browser transport/event-loop delivery before the channel callback,
small rendered-write/commit cost, and control-message pacing around input/resume traffic.

An untracked hot-typing resume guard was rejected and backed out. The experiment stopped
`armInteractiveEchoFastPath()` from sending an idle `ResumeAgent` unless the output pipeline had a
local flow-control pause, while preserving explicit spawn/recovery resumes. The narrow smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-hot-typing-untracked-resume-guard-smoke/summary.md`
proved the mechanical effect but regressed the product lane: resume sends dropped to 0, but pause
sends rose to 8, frame-gap p95 regressed to 283.30ms, long-task total to 4456ms, terminal render p95
to 4171.20ms, focused round trip to 1337.30ms, rendered round trip to 1847.30ms, input sent p95 to
748.40ms, and accepted p95 to 431.50ms. Do not suppress hot-path untracked resumes by itself; the
resume traffic is probably preventing pause-heavy stale-output behavior even though it shares the
client send buffer with input.

Terminal write diagnostics now also split xterm write duration from synchronous post-write
finalization inside the output callback. The narrow browser smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-finish-write-finalization-split-smoke/summary.md`
verified the new fields without changing runtime policy. It still missed the loaded lane on frame
gap and long tasks, but it kept focused round trip better than the rejected resume guard: frame-gap
p95 was 100.00ms, long-task total was 2566ms, focused round trip was 417.50ms, rendered round trip
was 493.10ms, render-after-receive was 75.60ms, and terminal render p95 was 2574.20ms. The useful
negative evidence is that write finalization is not the missing latency budget: terminal-write
duration p95 was 196.90ms, while write-finalization p95 was only 1.00ms overall and 2.80ms during
focused-input frames. Do not spend the next pass shaving callback bookkeeping. Keep the search on
xterm/terminal-render pressure, browser event-loop delivery, input dispatch, and input/resume
pacing.

Terminal write diagnostics now also split write shape into `plain`, `control`, and
`redraw-control` buckets. The narrow browser smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-write-shape-split-smoke/summary.md` verified the split
in real browser output. In that run, frame-gap p95 was 83.40ms, long-task total was 2707ms,
focused round trip was 491.90ms, rendered round trip was 701.40ms, render-after-receive was
209.50ms, terminal render p95 was 1069.50ms, and write-finalization p95 stayed low at 1.20ms
overall and 1.50ms during focused-input frames. The actionable split is that the per-frame write
duration p95 was entirely `redraw-control`: p95 bytes were plain 0, control 0,
redraw-control 7245, and write-duration p95 was plain 0.00ms, control 0.00ms, redraw-control
141.00ms. During focused-input frames, redraw-control writes were still the meaningful shape:
redraw-control bytes p95 7245 and redraw-control write-duration p95 71.00ms, while plain/control
duration stayed 0.00ms. Do not target generic plain-output writes or callback finalization next; the
next product-code experiment should explain and reduce redraw-control terminal write/commit pressure
without increasing stale visible output or input/resume churn.

A follow-up artifact review found that the first write-shape split could misattribute overlapping
write completions because diagnostics kept only one active write slot. Diagnostics now retain active
writes FIFO while preserving the public snapshot shape. The corrected browser smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-write-shape-fifo-smoke/summary.md` verified exact
write-call/write-duration alignment by shape: plain calls and durations were both 3, and
`redraw-control` calls and durations were both 94. The product signal stayed the same: frame-gap p95
was 100.10ms, long-task total was 3309ms, focused round trip was 562.40ms, rendered round trip was
752.00ms, render-after-receive was 207.40ms, terminal render p95 was 477.70ms, per-frame
`redraw-control` write-duration p95 was 185.60ms, and focused-input `redraw-control` write-duration
p95 was 93.80ms.

Shortening focused redraw coalescing during the interactive-echo window from 16ms to 8ms was tested
and rejected. The smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-focused-input-redraw-coalesce-8-smoke/summary.md`
improved frame-gap p95 to 83.40ms and per-frame `redraw-control` write-duration p95 to 150.70ms,
but it regressed the user-facing tail: long-task total rose to 4478ms, focused round trip to
678.20ms, input dispatch p95 to 390.80ms, and terminal render p95 to 957.90ms. Do not shorten
focused redraw coalescing by itself; the next retained product-code change needs to reduce
redraw-control pressure without increasing input dispatch, terminal render, or long-task cost.

A strict statusline redraw-supersession experiment was also tested and rejected. It attempted to
drop older queued save/cursor/clear-line/restore status frames for the same rows before writing to
xterm. The smoke at
`artifacts/terminal-ui-fluidity/2026-05-10-redraw-supersession-smoke/summary.md` reduced write
calls but made the product lane much worse: frame-gap p95 regressed to 299.90ms, long-task total to
5304ms, focused round trip to 2807.20ms, terminal render p95 to 5878.10ms, browser delivery p95 to
608.39ms, and `redraw-control` write-duration p95 to 466.30ms. It also exposed write-shape
attribution mismatch under the candidate, so the runtime change was backed out. Do not pursue
renderer-side lossy redraw supersession without a lower-level proof that it preserves diagnostic
attribution and does not create pause-heavy stale-output pressure.

This is useful progress for the measured hidden-switch lane and for diagnostics, but it is not full
loaded-goal proof. The remaining product-code target is the cross-layer acknowledgement and
backpressure path under loaded browser commit pressure: browser keyboard dispatch, command
acknowledgement, input/PTY/write acknowledgement, browser transport delivery, flow-control
pause/resume windows, redraw-control terminal write/commit cost, and sampled in-flight
visible-background write pressure when it overlaps focused input.

The latest splits make terminal-session channel dispatch, synchronous websocket send duration,
backend command-result generation, backend output buffering, terminal callback bookkeeping, generic
plain-output writes, and PTY queue/write policy weak next targets unless new evidence contradicts
them. Avoid repeating broad output-scheduler constant changes, trace-only completion,
focused-pressure removal, sustained input coalescing, in-flight interactive batching, fixed
echo-window write caps, broad focused preemption-window widening, terminal channel-dispatch
rewrites, finish-write bookkeeping rewrites, focused-input-only redraw coalescing cuts,
renderer-side lossy redraw supersession, or browser-control bufferedAmount tuning without a sharper
diagnostic that explains why the tail should improve.

Also avoid increasing the interactive input in-flight cap alone, raising the flow-control low
watermark broadly, coalescing duplicate resumes, request-tracking flow-control pause/resume,
input-coupled resume escape hatches, hot-path untracked resume suppression, or browser
`isInputPending` visible-background admission guards without a user-visible win. Rerun the smoke
scorecard only after the loaded matrix stops exposing a new loaded regression.

## Instrumentation First

Add a diagnostics path behind an explicit performance flag. It should be cheap when disabled and
structured when enabled.

Required marks:

- app start, browser bootstrap received, bootstrap applied
- selected task rendered, selected terminal focusable, selected terminal input accepted
- websocket connected, authenticated, replay started, replay complete
- terminal input created, websocket send started, server received, PTY write, PTY output echo,
  backend output flush, browser output received, terminal output painted
- terminal input buffered p95/max, terminal input sent p95/max, and flow-control pause/resume
  request windows in both per-run and matrix summaries
- terminal command-result receive p95/max and accepted-settle p95/max on the renderer side, plus
  backend command-result send and PTY-write-to-command-ack p95 in backend input traces
- terminal output write-duration p95 by priority/source, including focused-input visible-background
  write duration, so in-flight terminal writes can be separated from queue age and byte volume
- terminal output write-finalization p95 by priority/source, including focused-input
  visible-background finalization, so xterm write duration can be separated from callback
  bookkeeping
- terminal output write bytes and write-duration p95 by write shape (`plain`, `control`,
  `redraw-control`), including focused-input frames, so redraw-heavy terminal traffic can be
  separated from plain output and non-redraw control traffic
- terminal active-write count and max-age p95 by priority during all frames and focused-input
  frames, so writes that started before focused input can be distinguished from writes that
  completed during the focused-input window
- focused round-trip probe input-dispatch p95 and echo-after-dispatch p95, so long-marker typing
  cost is separated from terminal echo latency
- focused round-trip rendered p95 and render-after-receive p95, so terminal-handler receipt is
  separated from xterm write callback completion
- backend input trace server-queue, PTY-echo, backend-output-buffer, browser-delivery,
  browser-transport-delivery, browser-channel-dispatch, render, and end-to-end p95 splits
- browser-control websocket bufferedAmount high-water, delayed queue, and send-result counters
- browser-client control send attempts, nonzero buffered send attempts, pre-send and post-send
  bufferedAmount high-water, and synchronous send-duration p95, split by message type for input,
  resize, pause, and resume traffic
- task switch requested, selected task changed, terminal ready, focus restored
- review requested, diff data received, first useful rows painted, settled render
- preview expose requested, port known, iframe navigation started, iframe loaded
- remote shell loaded, takeover requested, takeover acknowledged, command accepted
- task cleanup requested, backend event received, stale surfaces removed

Artifacts:

- JSON trace for each run
- markdown summary with slowest spans
- commit, OS, CPU, memory, browser version, Node version, and profile name
- long tasks above 50ms
- websocket queue and backpressure indicators
- terminal renderer mode and terminal diagnostics

## Minimal Execution Path

1. Add the diagnostics marks and artifact writer.
2. Build `perf:scorecard:smoke` around the highest-friction journeys first: cold selected terminal,
   terminal typing under output, task switch, review, cleanup, remote command acknowledgement, and
   preview open.
3. Capture a reference baseline with three smoke repeats and one loaded run.
4. Pick the single worst user-visible miss, not the most interesting subsystem.
5. Run targeted experiments against that miss with one variable changed at a time.
6. Keep the winning product-code path, delete losing flags and branches, and add owner-local
   regression coverage for the invariant the change depends on.
7. Expand to the full scorecard only after smoke is stable and useful.
8. Lock budgets after baseline data is credible, then treat budget regressions as product
   regressions.

This path is short by design. It avoids a large browser matrix, avoids speculative rewrites, and
keeps the team focused on the most frustrating measured product behavior first.

## Experiment Loop

Every experiment must have:

1. A user journey and metric.
2. A bottleneck hypothesis.
3. One changed runtime policy or implementation path.
4. A before/after scorecard comparison.
5. A correctness lane for the owning layer.
6. A cleanup decision: keep and simplify, revise, or delete.

Failed experiments should not remain as permanent config branches.

## Candidate Experiments

Terminal typing:

- prioritize terminal input ahead of visible output flushes
- reduce output chunk sizes while input is active
- skip non-selected visible terminal fit work until selected paint is ready
- keep the focused terminal renderer retained across task switches
- downgrade hidden terminal renderer work until reselected

Task switching and startup:

- apply selected-task bootstrap categories before background categories
- retain selected terminal surface and replay only the minimal visible tail first
- move non-selected restore and attach work behind selected readiness
- avoid remounting task-panel subtrees that can safely consume updated view models

Review and diff:

- render visible diff rows before full syntax/decorations
- lazy-load Monaco only after first useful review shell
- cancel stale diff shaping and decoration work
- virtualize large files and branch/worktree diff lists

Preview:

- decouple port observation from iframe navigation
- preserve the iframe when metadata changes do not affect the selected URL
- cache safe probe results with explicit invalidation
- stream proxy responses without delaying first byte on non-policy work

Remote and reconnect:

- prioritize command, takeover, and selected-surface replay messages ahead of presence chatter
- compact replay payloads around selected task first
- batch noisy peer presence updates without delaying lease outcomes
- classify auth, network, replay, and ownership blockers at the transport boundary

Cleanup and stale state:

- make task removal a single canonical event path for terminal, review, preview, and command state
- prove stale panels unsubscribe from backend streams promptly
- remove stale local optimistic state once backend truth arrives

## Completion Criteria

The performance objective is complete when:

- every scorecard journey has a measured browser/server baseline
- every scorecard journey has an explicit budget and owner split
- smoke scorecard passes reliably on the reference machine
- full scorecard passes or has documented accepted limits
- the slowest measured journeys have been optimized or explicitly accepted
- owner-local tests protect the state machines behind each winning product-code change
- advanced browser capabilities remain intact: safe remote access, explicit port exposure,
  multi-client takeover, replayable backend state, and Electron as adapter
- no desktop-class performance claim relies only on microbenchmarks or headless integration tests

## What This Is Not

This is not a plan to make PR validation stricter first. It is a plan to make the runtime faster,
more predictable, and more visibly authoritative. Review and CI should preserve those product
properties after product code demonstrates them.
