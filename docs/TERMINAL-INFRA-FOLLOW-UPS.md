# Terminal And Browser-Control Follow-Ups

This document captures follow-up ideas after the recent browser-control, latency, takeover,
terminal attach, restore, and lifecycle hardening work.

It is not the canonical architecture document. Read these first for current truth and architectural
rules:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TESTING.md](./TESTING.md)
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md)

Use this note when deciding what to simplify next, what to measure next, and what should stay
deferred unless the data justifies it.

Treat any phase names or local `artifacts/terminal-ui-fluidity/...` paths in this file as
historical lab references only. They are useful when the matching local outputs still exist, but
they are not required review inputs and they do not define the current product validation
contract on their own.

## Purpose

The recent work fixed several real failure classes:

- stale retained control after takeover or transport loss
- ghost-send behavior across reconnect
- stale pending takeover requests
- task ownership and per-agent controller drift
- destructive terminal restore behavior and visible TUI instability
- timer and cleanup inconsistencies that only appeared under full-suite load

Those fixes improved correctness and exposed a clearer long-term direction:

1. the browser control plane should become more explicit, not more clever
2. terminal transport should distinguish interactive work from bulk work
3. lifecycle-sensitive code should prefer explicit state machines and generations over ad hoc flags
4. correctness needs stronger invariant and stress coverage, not only more happy-path tests

## Non-Negotiable Architectural Constraints

Any future work in this area should continue to respect these rules:

1. backend or browser control plane owns canonical multi-client state
2. transport classes route and validate, but do not own task policy
3. renderer can optimize scheduling, but must not speculate on terminal truth
4. dialogs, banners, and leaf components present control state; they do not define it
5. local terminal fit stays local and must not imply PTY resize authority

## Near-Term Recommendation

If we only take a few follow-up slices soon, take them in this order:

1. explicit browser command classes so ephemeral work never rides reconnect queues by accident
2. a single clearer ownership model for task control, terminal control, and resize authority
3. a first-class takeover state machine with explicit disconnect and timeout transitions
4. model-based multi-client invariants plus invariant-aware stress checks
5. differential restore only after ownership and transport semantics are simpler

## Measured Direction For Many-Terminal Performance

The current steady-state evidence changes what should be optimized first.

What the browser UI-fluidity profiler is already good at separating:

- backend/session pressure versus browser main-thread pressure
- app-owned scheduler or analysis cost versus xterm/write-path cost
- visible UI jank versus hidden-terminal backlog

Current measured direction:

1. backend/session fanout is not the leading limiter for 20-25 active terminals
2. app-owned scheduler and output-analysis bookkeeping are usually small compared with render-path
   delay
3. visible-heavy verbose terminals can still blow frame and long-task budgets
4. many hidden verbose terminals can build multi-second queue and render backlogs even when the
   visible UI stays mostly fluid

Practical consequence:

- do not start the next performance pass with more scheduler bookkeeping or generic store cleanup
- prefer follow-ups that reduce steady-state live renderer work or hidden-terminal backlog
- keep browser UI-fluidity evidence as the gate before taking larger architectural slices such as
  hidden-terminal hibernation or moving non-authoritative analysis off the main thread

What the current variant experiments suggest:

1. a short focused-only preemption window is the current product default because it improves task
   selection and interactive responsiveness without introducing new recovery semantics
2. hidden-terminal hibernation and true hidden-session dormancy both change the cost profile, but
   their current wake/restore models are still too disruptive to treat as direct product fixes
3. a more aggressive bulk-oriented preemption window can improve backlog and render latency, but the
   current 24-terminal data also shows worse visible frame-gap tails, so it stays experimental
4. bulk visible verbose output still needs a better answer than simple background-budget tuning or a
   one-shot write-shaping pass
5. static write-batch caps are not a safe global default; the current browser data shows that a
   cap can help the one-visible case while regressing four-visible or denser layouts badly enough to
   fail the product bar
6. render freeze is still the least disruptive hidden-terminal lever we have measured, but task
   switches and wake restore still need a better handoff model before it is safe to roll out
7. tiered hidden-session dormancy with focused preemption stays deferred for now; current direct
   browser runs either fail to reach the render-hibernation stage at all or still produce
   unacceptable wake/session-switch latency
8. a first hover-intent render-freeze prewarm pass improved some one-visible hidden-switch
   readiness, but it still regressed four-visible task switching and interactive verbose load
   badly enough to stay experimental
9. a first visibility-aware pacing pass reduced some hidden backlog and one-visible diff bursts,
   but it regressed bulk and structured visible workloads enough that it is not a product-ready
   replacement for the current focused-preemption floor
10. bounded hot-hidden live sets are now measured and still deferred; they improved some cold
    render-freeze switch cases, but the recent-hidden browser runs still regressed interaction and
    timed out enough that they are not a product-ready replacement for the current default
11. the strongest current visible-render candidate is a balanced frame-budgeted plus adaptive
    visible-background policy, but it still stays experimental; the current 24-terminal browser
    runs improved four-visible recent-hidden switching and interactive verbose load materially, but
    they still regressed one-visible hidden switching and enough structured visible workloads to
    fail the product bar
12. a later hybrid sparse-versus-multi-visible pass narrowed the tradeoff but still did not clear
    the product bar; the balanced policy stayed the strongest contender overall, while the simpler
    multi-visible split and the added switch-protection pulse both still left recent-switch or bulk
    regressions large enough to block rollout
13. a shared post-first-paint cap for non-target visible terminals during the switch window stays
    deferred; the first 24-terminal browser pass improved a few sparse metrics but regressed
    `2 visible` and `4 visible` recent-hidden switching badly enough that it is not a
    production-safe follow-up to the current switch-window work
14. after fixing the browser baseline injection bug and the queued switch-target drain bug, the
    corrected shared-visible-budget rerun still stayed deferred; the looser shared budget improved
    `2 visible` recent hidden switching and interactive responsiveness materially, while the tight
    cap improved some switch timings and bulk long-task totals, but neither variant survived the
    full `1 / 2 / 4 visible` sweep without new `bulk_text` regressions or worse hidden-task
    switching in another layout shape
15. the corrected hard switch-window contract rerun also stays deferred; protecting the switch
    target through input-ready and adding a longer settle window improved some dense visible bulk
    numbers, but the valid rerun still regressed sparse switching or interactive responsiveness
    enough that it does not clear the product bar. The review also surfaced one non-negotiable
    lifecycle rule for future work: app-owned input-ready must never be recorded before
    first-paint, and neither timing should complete before the selected terminal is actually
    visible
16. the newer reserve-plus-frame-shaped visible-budget hybrid is the best recent narrow follow-up,
    but it still stays experimental. The base hybrid improved sparse switching and the `2 visible`
    interactive case, while the `>=4 visible` aggressive `active-visible` follow-up improved some
    dense switch and bulk render/long-task medians. Neither variant survived the full
    `1 / 2 / 4 visible` gate without new sparse bulk or dense interactive/frame-gap regressions,
    so the current short focused-preemption floor remains the product default
17. `active_visible_selected` is now the correct browser proof for `active-visible` work, but it
    is supporting evidence only. A candidate that looks good there still has to clear the main UX
    gate on `recent_hidden_switch`, `interactive_verbose`, and `bulk_text`
18. the new dense-only visible-background pressure variants are also still experimental. The looser
    `multi_visible_reserve_shared_tight_frame_shaped_dense_pressure_visible_background` variant
    improved some `2 visible` bulk render cost, but it still regressed sparse bulk frame-gap and
    dense interactive responsiveness. The tighter
    `multi_visible_reserve_shared_tight_frame_shaped_dense_pressure_visible_background_tight`
    variant is the current best dense-only follow-up: it preserved sparse switching, improved
    `2 visible` switching and interactive responsiveness, and materially improved `4 visible`
    switch, bulk long-task, and bulk render medians versus `product_default`. It still regressed
    sparse bulk render/long-task pressure and remained slower than the older base hybrid on
    `4 visible` interactive responsiveness, so it stays deferred as a benchmark reference rather
    than a rollout candidate
19. explicit High Load Mode is now a real product seam, but it is still not the universal fallback
    baseline. The setting is renderer-local, defaults on for fresh browser sessions, and routes
    through the app-owned
    `terminal-high-load-mode` mirror instead of letting app modules read `store/core`. The dense
    gate in
    `phase-high-load-mode-dense-gate-2026-03-24-r1`
    showed `guarded_dense_overload_reference` improving dense `recent_hidden_switch`,
    `interactive_verbose`, and `bulk_text` long-task totals versus `product_default`, but it still
    lost clearly to `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled` on
    dense `interactive_verbose` and dense bulk frame-gap/long-task pressure. The sparse/few-visible
    rerun in
    `phase-high-load-mode-inertness-2026-03-24-r1`
    is good enough to keep the mode as an advanced opt-in, but not good enough to treat it as
    behavior-identical to `product_default` when a user leaves the setting enabled outside dense
    overload
20. explicit High Load Mode now also has a product-facing built-in runtime profile, measured by the
    `high_load_mode_product` browser variant instead of a profiling-only injected experiment. The
    earlier direct rerun in
    `phase-high-load-mode-rebased-direct-2026-03-24-r1`
    was noisy enough to need a clean repeated rerun. The authoritative dense result is now
    `phase-high-load-mode-convergence-2026-03-24-r2`:
    it improved dense `bulk_text` frame-gap/long-task totals versus `product_default`
    (`200.10ms / 1146.00ms -> 166.70ms / 676.00ms`), but it still regressed dense
    `recent_hidden_switch` (`532.10ms -> 626.00ms`), dense `interactive_verbose`
    (`360.00ms -> 413.70ms`), and dense bulk render p95 (`2775.80ms -> 3254.70ms`). Treat it as
    the real opt-in implementation seam, not as the best dense policy or a universal-default
    candidate
21. the earlier role-based passive-visible mirror design is now explicitly deferred. We tried a
    High Load Mode seam where `terminal-surface-tiering` assigned extra visible roles and
    `TerminalView` substituted passive mirror UI for visible siblings while the live renderer
    hibernated, but that product model regressed truthfulness and desktop-grade usability. Treat
    the current owner split as: tiering/scheduler may deprioritize visible siblings, but visible
    panels must remain real terminal surfaces. The direct dense reruns in
    `phase-role-based-high-load-mode-debug-2026-03-24-r1`,
    `phase-role-based-high-load-mode-debug-2026-03-24-r2`,
    and
    `phase-role-based-high-load-mode-debug-2026-03-24-r3`
    showed:
    - `high_load_mode_product / 24 / 4 visible / recent_hidden_switch = 3217.20ms`
    - `high_load_mode_product / 24 / 4 visible / interactive_verbose = 2061.90ms`
    - `high_load_mode_product / 24 / 4 visible / bulk_text = frame-gap p95 350.10ms`,
      `longtasks 2184.00ms`
    - matching direct `product_default` dense rerun stayed materially better on hidden switch and
      bulk (`832.30ms`, `266.60ms`, `2096.00ms`)
      The interrupted matrix under
      `phase-role-based-high-load-mode-2026-03-24-r1`
      should be treated as incomplete evidence only; use the direct dense reruns as the authoritative
      result for this pass
22. selected-terminal recovery shielding on the default path is now stronger: while the selected
    recovery window is active, unrelated visible backlog is blocked alongside unrelated hidden
    backlog. Runtime tests prove the new ordering path. The loaded direct rerun in
    `phase-default-selected-recovery-direct-2026-03-24-r1`
    should be treated as superseded. The authoritative clean repeated gate is now
    `phase-default-selected-recovery-convergence-2026-03-24-r2`:
    `1 visible recent_hidden_switch=433.80ms` and `2 visible recent_hidden_switch=596.30ms`, with
    no timeouts. So this pass is implemented, worth keeping, and browser-cleared for bounded
    sparse/few-visible hidden switching even though it is not yet a broad performance breakthrough
23. role-based High Load Mode selected handoff is no longer catastrophically broken after moving
    switch-window arming ahead of selected-session revival. The authoritative dense rerun is now
    `phase-role-based-high-load-mode-fix-2026-03-24-r3`:
    - `high_load_mode_product / 24 / 4 visible / recent_hidden_switch = 212.30ms`
    - matching `product_default / 24 / 4 visible / recent_hidden_switch = 148.50ms`
    - `high_load_mode_product / 24 / 4 visible / bulk_text = frame-gap p95 183.30ms`,
      `longtasks 626.00ms`
    - matching `product_default / 24 / 4 visible / bulk_text = frame-gap p95 250.10ms`,
      `longtasks 992.00ms`
    - `high_load_mode_product / 24 / 4 visible / interactive_verbose` still timed out while
      `product_default` finished at `177.90ms`
      Treat this as a narrowed defer, not a rollback: the next dense convergence target is steady
      focused interaction under load, not selected switch-handoff correctness.
24. the later dense focused-input protection pass kept the correct High Load Mode UX contract:
    passive-visible panes may stay stale during active focused input, but they should not own PTY
    flow control. A direct browser attempt to wire suppressed passive-visible bytes into
    pause/resume behavior made the dense `recent_hidden_switch` target age out before measurement,
    so that transport-level approach stays rejected. The narrower stale-passive reruns are now:
    - direct dense `recent_hidden_switch` under
      `phase-dense-focused-input-protection-2026-03-24-r4`:
      `product_default=144.50ms`, while `high_load_mode_product` failed because the prepared recent
      hidden target aged out before measurement
    - direct dense steady-state reruns under
      `phase-dense-focused-input-protection-2026-03-24-r5`
      still show High Load Mode's split truth:
      `bulk_text` improved (`166.70ms / 677.00ms` versus `200.00ms / 1994.00ms`), but
      `interactive_verbose` still timed out with `frame-gap p95=133.30ms` and
      `longtasks=991.00ms`
    - keep the stale-passive behavior; reject suppressed-output transport ownership for now
    - the next dense convergence target is focused interaction starvation plus recent-hidden target
      aging, not more passive-visible transport control
25. the explicit High Load Mode product path is now rebased back to the proven exact-count dense
    scheduler core, and the repeated direct dense release gate confirms it is ready to ship as the
    explicit setting implementation. The direct rerun in
    `phase-high-load-mode-ship-check-2026-03-25-r1`
    showed:
    - `high_load_mode_product / 24 / 4 visible / recent_hidden_switch = 137.20ms` versus
      `526.20ms` on `product_default`
    - `high_load_mode_product / 24 / 4 visible / interactive_verbose = 147.20ms` versus
      `149.60ms` on `product_default`
    - dense `bulk_text` frame-gap stayed effectively tied (`166.70ms` versus `166.60ms`)
    - dense `bulk_text` long-task total improved from `891.00ms` to `754.00ms`
    - dense render p95 was still worse (`4723.10ms` versus `3197.40ms`)
    - keep `product_default` as the explicit forced-off fallback, while fresh browser sessions
      default the built-in High Load profile on
    - keep the role-based passive-visible and reservation-ring family deferred until it can beat
      this direct dense gate by itself
26. the release story now also has a matching narrow default-path sanity proof in
    `phase-product-default-sanity-2026-03-25-r1`:
    - `product_default / 24 / 1 visible / recent_hidden_switch = 211.40ms`
    - `product_default / 24 / 1 visible / interactive_verbose = 149.35ms`
    - `product_default / 24 / 2 visible / recent_hidden_switch = 381.50ms`
    - `product_default / 24 / 2 visible / interactive_verbose = 282.75ms`
      Treat that narrow gate as the safety bar before changing the split product story.
27. the focused first-echo reservation plus recent-hidden reservation-ring follow-up is also still
    a measured defer. It correctly kept the new policy in `workflow / app` and
    `presentation` owners, but the direct dense rerun in
    `phase-dense-echo-reservation-recent-hidden-ring-2026-03-24-r1`
    still did not clear the product bar:
    - `product_default / 24 / 4 visible` stayed clean at
      `recent_hidden_switch=204.00ms`, `interactive_verbose=177.20ms`, and
      `bulk_text=150.00ms / 718.00ms`
    - `high_load_mode_product` dense steady-state still failed:
      `interactive_verbose` timed out with `frame-gap p95=200.00ms` and
      `longtasks=1459.00ms`
    - `high_load_mode_product` dense bulk no longer preserved the earlier long-task win:
      `bulk_text frame-gap p95=166.60ms`, `longtasks=2850.00ms`
    - the dense recent-hidden preparation bug was still unresolved: the combined rerun aged the
      prepared target out before measurement, and the isolated follow-up probe still failed to
      produce a clean switch measurement
    - keep the new app-owned seams:
      focused first-echo reservation in `terminal-focused-input` and recent-hidden reservation in
      `terminal-recent-hidden-reservation`
    - do not assume those seams are sufficient. The next dense pass still needs a different answer
      for steady focused interaction plus recent-hidden preparation under `24 / 4 visible`.

## What To Improve Next

### 0. Close Visibility-Aware Output Pacing As An Active Track

The bounded A/B/C visibility-aware pacing ladder is now closed. None of the candidates beat the
shipped default-on High Load profile cleanly enough to justify promotion.

Authoritative phase summary:

- `phase-visibility-aware-output-pacing-2026-03-25-r1/summary.md`

What the measured result says:

- keep `high_load_mode_product` as the shipped default-on High Load profile
- reject Candidate A because it regressed light-layout switching and dense bulk
- reject Candidate B because it improved dense switch medians but regressed dense interactive and
  dense bulk while also worsening `2 visible` switching
- reject Candidate C because it failed the light-layout safety bar before the ladder even finished

Hard call:

- there is no active terminal-performance follow-up track right now
- do not keep visibility-aware pacing open as “pending”
- only reopen it if a new falsifiable scheduler/write-shaping hypothesis can beat the current
  shipped `high_load_mode_product` gate across the same `1 / 2 / 4 visible` checks

### 0a. Close Trace-Driven Recovery-Batch Release Pacing As An Active Track

The trace-driven replay/restore follow-up is also closed with no promotion. The dense traces did
find a real renderer-side cost center in `scrollbackRestore` attach-batch result release, but the
browser-gated tuning still did not produce a stable win once we reran the dense gate on rebuilt
artifacts.

Authoritative phase summaries:

- `phase-recovery-batch-release-pacing-2026-03-25-r3/summary.md`
- `phase-recovery-batch-release-pacing-2026-03-25-r4/summary.md`

What the measured result says:

- the `8`-release attach pacing looked directionally good in one clean dense pass:
  `high_load_mode_product / 24 / 4 visible` reached
  `recent_hidden_switch=131.10ms`, `interactive_verbose=169.10ms`,
  `bulk_text frame-gap=150.00ms`, `bulk_text longtasks=546.00ms`
- but the repeated dense rerun did not sustain a clear win:
  `high_load_mode_product` landed at
  `recent_hidden_switch=153.05ms`, `interactive_verbose=146.10ms`,
  `bulk_text frame-gap=175.05ms`, `bulk_text longtasks=1890.50ms`
- the same repeated rerun also showed the fallback baseline moving around enough that the host was
  no longer clean promotion evidence

Hard call:

- keep the shipped `high_load_mode_product` profile unchanged
- do not move renderer-side attach result release pacing into the product path
- keep the trace lesson, but archive the implementation experiment unless a future rebuilt and
  repeated dense gate proves a stable win

### 0aa. Close Fit/Layout Churn As An Active Track

The fit/layout churn branch is also closed with no promotion. The diagnostics work was worth
keeping because it made fit attribution explicit in the browser summaries, but none of the bounded
fit candidates beat the current shipped dense floor.

Authoritative phase summaries:

- `phase-fit-layout-candidate-a-2026-03-25-r1/summary.md`
- `phase-fit-layout-candidate-b-2026-03-25-r1/summary.md`
- `phase-fit-layout-candidate-c-2026-03-25-r1/summary.md`

What the measured result says:

- Candidate A no-op fit suppression regressed dense switch and dense interaction enough to miss the
  shipped floor immediately
- Candidate B fit-ready deduplication improved one dense bulk tail but still lost the shipped floor
  on dense `recent_hidden_switch` and `interactive_verbose`
- Candidate C dirty-mark coalescing also missed the shipped floor on all four dense ship metrics:
  `recent_hidden_switch=167.30ms` vs shipped `137.20ms`,
  `interactive_verbose=175.45ms` vs `147.20ms`,
  `bulk_text frame-gap=183.25ms` vs `166.70ms`,
  `bulk_text longtasks=1491.00ms` vs `754.00ms`
- the useful surviving result is the fit attribution itself:
  repeated dense summaries now show manager/session fit counts and dirty-mark reasons directly

Hard call:

- keep the current shipped `high_load_mode_product` profile unchanged
- keep fit diagnostics in the browser summary path
- do not keep fit/layout churn open as implied future work
- only reopen this seam if a new falsifiable fit/layout hypothesis can beat the same shipped dense
  gate on rebuilt artifacts

### 0ab. Close WebGL / Renderer Churn As An Active Track

The WebGL / renderer churn branch is also closed with no promotion. The attribution work was worth
keeping because browser summaries now expose pool churn and per-frame active/visible WebGL counts,
but the corrected dense shipped-path gate showed no meaningful acquire/evict/fallback churn during
the measured workload.

Authoritative phase summary:

- `phase-webgl-attribution-2026-03-25-r1/summary.md`

What the measured result says:

- the shipped dense gate remained healthy:
  `recent_hidden_switch=199.15ms`, `interactive_verbose=177.75ms`,
  `bulk_text frame-gap=174.90ms`, `bulk_text longtasks=313.50ms`
- per-frame samples showed stable active WebGL usage (`active-webgl-p95=6`) instead of context
  churn
- the renderer churn counters stayed flat during the measured window:
  `acquire-attempts=0`, `evictions=0`, `fallbacks=0`, `recoveries=0`
- that means the current shipped dense workload is not spending time repeatedly acquiring,
  evicting, or recovering WebGL contexts, so bounded WebGL policy candidates A/B/C were not
  justified

Hard call:

- keep the current shipped `high_load_mode_product` profile unchanged
- keep the renderer/WebGL diagnostics in the browser summary path
- do not keep WebGL pool policy work open as implied future work
- only reopen this seam if a new falsifiable hypothesis first shows nontrivial measured renderer
  churn on the rebuilt dense gate

### 0b. Separate Recent Hidden Switch From Cold Hidden Wake

The recent browser work showed that these are different user problems and different lifecycle
states.

Future direction:

- keep one suite that proves cold hidden wake or render-hibernation restore
- keep a separate recent-hidden switch suite for experiments that are supposed to optimize recently
  active hidden tasks
- record switch first-paint and input-ready separately so wake improvements do not hide a slower
  handoff

Why this helps:

- avoids falsely “proving” a recent-switch optimization against a cold hidden target
- keeps hidden-terminal lifecycle work tied to the real UX question it is trying to improve

Likely owner:

- workflow / app
- presentation
- browser-lab harness

Validation seam:

- runtime / integration

Recommendation:

- use the recent-hidden suite before taking another bounded hot-hidden or live-surface tiering
  pass
- keep the current hot-hidden experiments deferred; the first measured variants still fail the
  product bar

### 0a. Improve Render-Freeze Wake Handoff Before Deeper Dormancy Work

The render-freeze path remains the most credible hidden-terminal cost lever, but wake and switch
latency are still too high.

Future direction:

- keep a frozen surface available immediately on task switch
- start restore behind that preserved surface instead of making the switch wait for the whole wake
  path to settle
- consider lightweight prewarm only from explicit navigation intent, not from hidden output churn

Why this helps:

- targets the measured failure mode directly: render freeze lowers steady-state hidden cost, but the
  current wake handoff still feels too slow
- avoids skipping straight to more disruptive true dormancy models before the less-destructive wake
  path is good enough

Likely owner:

- workflow / app
- presentation

Validation seam:

- runtime / integration
- browser UI-fluidity profiler

Recommendation:

- do this before taking another full-session dormancy slice
- keep the first sidebar-hover prewarm attempt experimental; current browser runs show that a
  lighter one-visible win can still turn into a four-visible regression

### 1. Make Browser Commands Explicitly Classed

Several recent bugs came from treating all browser commands as if they had the same lifecycle.

Future direction:

- define explicit command classes:
  - `immediate`
  - `queueable`
  - `replayable`
  - `ephemeral`
- keep `input`, `resize`, and takeover request/response on the `immediate` / non-reconnecting path
- keep presence, bootstrap, and replayable state refresh on reconnect-safe paths
- keep command-class policy in one transport seam instead of spreading it across callers

Why this helps:

- prevents ghost work after reconnect
- makes lifecycle expectations visible in code review
- reduces the chance that a new ephemeral command accidentally inherits queue-on-reconnect behavior

Likely owner:

- handler / transport

Validation seam:

- node / backend
- runtime / integration

Recommendation:

- treat this as the default transport model for future browser control-plane commands, not a one-off
  fix for terminal input

### 2. Collapse Control Ownership Into A Clearer Model

Task ownership and per-agent terminal ownership are currently related but still require
reconciliation.

Future direction:

- make task control the primary ownership model
- make per-agent terminal control either:
  - explicitly derived from task ownership, or
  - owned by one canonical server-side controller graph instead of opportunistic reconciliation
- ensure resize authority is part of the same ownership family instead of a parallel concept

Why this helps:

- fewer ways for control state to drift
- fewer cleanup paths that need bespoke repair logic
- simpler takeover and disconnect semantics

Likely owner:

- backend
- workflow / app

Validation seam:

- node / backend
- browser lab

Recommendation:

- do not move this logic into terminal components
- prefer a server-owned state machine plus thin client projections

### 3. Promote Takeover Into A First-Class State Machine

The takeover path is still more implicit than ideal.

Future direction:

- model task takeover requests as explicit states:
  - `idle`
  - `requested`
  - `awaiting-owner`
  - `approved`
  - `denied`
  - `timed-out`
  - `force-eligible`
  - `canceled`
- define canonical transitions for:
  - owner disconnect
  - requester disconnect
  - controller change
  - timeout
  - transport loss
- emit those transitions as explicit control-plane events

Why this helps:

- easier reasoning about races
- easier stress/fuzz testing
- less UI ambiguity around what the user should see

Likely owner:

- backend
- handler / transport

Validation seam:

- node / backend
- browser lab

Recommendation:

- keep timeout policy and resolution rules out of dialogs
- dialog and banner surfaces should consume state-machine output, not define it

### 4. Add Periodic Server-Side Reconciliation For Live Control State

Recent fixes added targeted reconciliation. A periodic audit pass would make the system more
robust under rare or future failure modes.

Future direction:

- add a light server-side audit loop that periodically checks:
  - task owners
  - agent controllers
  - resize authority
  - pending takeover requests
  - peer presence
- repair or prune impossible combinations
- emit diagnostics when repair happens

Why this helps:

- catches missed cleanup paths
- makes latent drift observable
- gives production diagnostics a place to attach invariant failures

Likely owner:

- backend

Validation seam:

- node / backend
- stress harness

Recommendation:

- keep the audit loop conservative and idempotent
- prefer logging and repair over silently mutating state without diagnostics

### 5. Use Generation Tokens And Abortable Operations More Consistently

Some recent bugs were stale-work bugs, not raw logic bugs.

Future direction:

- use generation tokens or explicit operation IDs for:
  - terminal session lifetime
  - control handoff requests
  - restore requests
  - active preview scans
  - future multi-step browser workflows
- add abortable send/operation wrappers for cancellable client work

Why this helps:

- stale results cannot mutate newer sessions
- reconnect and teardown bugs become easier to reason about
- lifecycle cleanup becomes less dependent on timing luck

Likely owner:

- workflow / app
- handler / transport

Validation seam:

- runtime / integration
- browser lab

Recommendation:

- use the same pattern repeatedly instead of inventing new ad hoc invalidation flags

### 6. Keep Interactive And Bulk Terminal Traffic On Different Policies

Interactive typing and bulk replay are not the same workload and should continue to diverge.

Future direction:

- keep a dedicated interactive fast path for:
  - small terminal input
  - control keys
  - small echo-sized output
- keep bounded batching and restore-specific scheduling for:
  - paste
  - replay
  - large output bursts
  - background terminal attach
- consider per-lane diagnostics and budgets instead of one monolithic terminal latency number

Why this helps:

- the common path stays fast
- heavy workloads stay safe
- performance tuning remains measurable instead of anecdotal

Likely owner:

- backend
- handler / transport
- workflow / app

Validation seam:

- node / backend
- stress harness
- browser lab

Recommendation:

- keep this model even if a future binary input fast path is added

### 7. Prefer Differential Restore Over Destructive Reset

Terminal restore and reconnect issues have repeatedly shown that full reset and replay is too blunt
for many TUIs.

Future direction:

- track recent output by sequence and restore incrementally when possible
- keep hard reset as a fallback, not the default
- distinguish:
  - reconnect catch-up
  - renderer-loss repaint
  - hard reset recovery
- keep the visible viewport stable until replacement content is ready

Why this helps:

- less flicker
- better TUI stability
- less redundant work during reconnect and late join

Likely owner:

- backend
- workflow / app

Validation seam:

- node / backend
- browser lab

Recommendation:

- only consider deeper client-side archival or paging if measured replay size and restore time force
  it

### 8. Treat Resize Authority As Part Of Control, Not Just Terminal Geometry

Terminal resize bugs are multi-client control bugs in disguise.

Future direction:

- keep canonical PTY resize authority server-owned
- prevent observer mounts, visibility changes, and local fit from mutating PTY size
- make resize authority transfer explicit with control handoff
- surface mismatch state clearly to observers without letting them clobber the controller

Why this helps:

- fewer surprising PTY reflows
- simpler mental model for multi-client terminal behavior
- easier invariant testing

Likely owner:

- backend
- workflow / app

Validation seam:

- node / backend
- browser lab
- stress harness

Recommendation:

- keep local xterm fit as presentation only

### 9. Make Background Attach And Replay Explicitly Lower Priority

Mount-driven terminal attach has improved, but the longer-term design should make scheduler policy
the only authority for expensive attach work.

Future direction:

- keep active task and active terminal attach first
- delay background restore and replay until the visible task is usable
- cap concurrent background attaches
- measure first-interactive time separately from total background restore completion

Why this helps:

- better perceived speed
- fewer replay bursts competing with the visible terminal
- less accidental jank on page load

Likely owner:

- workflow / app

Validation seam:

- browser lab
- stress harness

Recommendation:

- do not let low-level terminal views decide attach priority on their own
- keep using the phase-traced startup benchmark before changing concurrency policy again:
  recent results showed queue wait was small while snapshot replay/apply dominated total startup
  time, so any future concurrency work should only proceed after a benchmark proves it beats replay
  throughput tuning on full-terminal completion time
- avoid larger hidden-only or background-only replay chunk jumps without a fresh benchmark: the
  measured startup sweeps showed those profiles regressed `5`-shell completion and could even stall
  `15`-shell manual runs, while the safer mixed profile was the only one that improved full
  completion time

## Reliability And Test Strategy Follow-Ups

### 10. Add Model-Based Multi-Client State-Machine Tests

The current suite is good, but many of the hardest bugs are still “unexpected sequence” bugs.

Future direction:

- build a state-machine or command-sequence harness for multi-client actions:
  - connect
  - disconnect
  - reconnect
  - acquire control
  - request takeover
  - deny / approve
  - resize
  - type
  - restore
  - hide / show tab
- run randomized or matrix-driven sequences against invariant checks

Core invariants:

- at most one controller per task
- at most one resize authority per agent
- stale client work never mutates live ownership
- requester disconnect clears pending owner prompt
- ownership move reconciles dependent control state
- observer resize never changes PTY size

Why this helps:

- catches race conditions humans do not enumerate manually
- protects against future regressions in transport and lifecycle code

Likely owner:

- node / backend
- stress harness

Validation seam:

- node / backend

Recommendation:

- keep this harness deterministic enough to reproduce failures with logged seeds

### 11. Expand Stress Harnesses From Perf-Only To Invariant-Aware

The stress suites should not only measure latency. They should also fail on invalid live states.

Future direction:

- extend stress scenarios to assert:
  - no dual controller states
  - no impossible pending takeovers
  - no stale presence after disconnect
  - no resize-authority drift
  - no replay cursor regressions
- emit invariant counters in diagnostics artifacts

Why this helps:

- performance and correctness failures often share the same underlying race
- makes the heavy harnesses more useful as release gates

Likely owner:

- backend
- diagnostics / testing

Validation seam:

- stress harness

### 12. Standardize Cleanup Discipline In Tests

Several flaky failures this session were test-lifecycle bugs, not product bugs.

Future direction:

- provide shared helpers for:
  - fake timer setup and teardown
  - singleton reset
  - websocket/server cleanup
  - event-listener cleanup
- require those helpers in high-risk suites
- prefer wrappers that make incomplete cleanup harder to write

Compile-time and review-time guard ideas:

- keep `no-floating-promises` strict for test helpers
- use typed cleanup handles or `Disposable`-style wrappers where practical
- prefer APIs that return one structured cleanup object over multiple ad hoc disposers
- keep explicit `resetForTests()` exports for modules with singleton state

Why this helps:

- fewer suite-order failures
- clearer ownership of global test state
- easier review of lifecycle correctness

Likely owner:

- testing utilities

Validation seam:

- docs / sanity
- full-suite stability

Recommendation:

- bias toward patterns that fail loudly when cleanup is forgotten

## Performance Follow-Ups Worth Revisiting Later

These are intentionally deferred until the current latency and restore work has stronger measured
budgets behind it.

### A. Binary Input Fast Path

Possible value:

- remove some serialization cost on the browser hot path

Recommendation:

- revisit only if the current interactive RTT budgets are still not being met after timer,
  batching, and lease hot-path tuning

### B. Richer Differential Screen Snapshots For TUIs

Possible value:

- further reduce flicker for full-screen terminal apps

Recommendation:

- revisit only if sequence-based incremental replay is still insufficient for real TUI workloads

### C. Deeper Scrollback Archival

Possible value:

- reduce restore cost for very large histories

Recommendation:

- revisit only if measured replay bytes and restore time justify the additional complexity
- do not jump to IndexedDB paging by default

### D. Hard Switch-Window Contract Tuning

Observed result:

- the hard switch-window contract and longer settle windows helped some multi-visible bulk cases,
  but the corrected browser matrix still moved pain around instead of clearing the product bar
- sparse recent hidden switching and multi-visible interactive pressure still regressed enough that
  the policy is not safe to ship as the default

Recommendation:

- keep the short focused-preemption floor as the shipped behavior for now
- revisit only after the visible main-thread rendering budget is improved more fundamentally
- do not treat longer switch settlement or harder non-target suppression as a production answer by
  themselves

### E. Active-Visible Pressure Yielding

Observed result:

- the first pressure-driven yielding pass for `active-visible` terminals was not a product win
- the generic browser gate still reported `active-visible-bytes p95=0` across the many-terminal
  runs, so those profiles were not a valid promotion gate for an `active-visible` scheduling policy
- the new dedicated `active_visible_selected` browser suite now proves real `active-visible` work
  with nonzero per-frame `active-visible` bytes across `1`, `2`, and `4 visible` layouts
- the new variants regressed switching and bulk cases badly enough to defer them

Recommendation:

- keep the scheduler proof at the runtime seam, and use `active_visible_selected` whenever a
  browser run is supposed to validate `active-visible` behavior specifically
- do not treat the generic visible browser matrix as a valid `active-visible` promotion gate on its
  own; it still mostly measures `focused` and `visible-background` work
- prioritize visible-background and visible-write budget work before returning to this lane

### E. Pressure-Driven Visible Yielding

Observed result:

- adding frame-pressure throttling for `active-visible` terminals improved some dense visible
  slices, but it still regressed sparse hidden switching badly enough to fail the production bar
- the aggressive variant improved some `4 visible` bulk numbers, but it also pushed `2 visible`
  interactive throughput back into clearly degraded territory

Recommendation:

- keep this as an experimental lever, not the shipped default
- revisit only after the switch-target lifecycle and visible frame budget are stronger enough that
  sparse hidden switches do not get starved
- do not treat pressure-driven yielding alone as the major production unlock

### F. Hidden-Handoff Revisit

Observed result:

- the new active-visible proof suite fixed a browser-gate blind spot, but it did not produce a new
  visible-path win that would justify reopening hidden-terminal handoff work yet
- render-freeze, prewarm, hot-hidden, and dormancy follow-ups should still be judged against a
  healthier visible rendering baseline first

Recommendation:

- keep hidden-terminal handoff and backend-assisted wake deferred for now
- return to hidden-terminal lifecycle work only after a visible-frame-budget candidate produces a
  clear product-safe gain on the current `1/2/4 visible` browser gate

### G. Shape-Split Visible Budgeting

Observed result:

- the new exact visible-count override layer was the right experiment seam; it let terminal
  variants tune `1`, `2`, and `4 visible` layouts separately without redefining the existing
  `single / few / dense` buckets
- `shape_split_visible_budget_dense_pressure_reference` proved the seam, but it still regressed
  `1 visible` bulk hard enough to disqualify it as the next broad benchmark
- `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled` is the current
  broad comparison point:
  - it improved sparse interactive responsiveness and some sparse bulk long-task pressure
  - it stayed better than `product_default` on some dense interactive medians
  - but it still failed the product bar because sparse recent-hidden switching regressed and it
    did not keep a clean few-visible or dense bulk advantage in the latest reruns
- `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse_switch_echo_grace`
  made the new post-input-ready echo window measurable, but it did not become the next broad
  benchmark:
  - it recorded a completed app echo window in sparse hidden-task switches
  - it improved some `2 visible` and `4 visible` hidden-switch medians
  - but it also reopened sparse interactive and few-visible bulk regressions badly enough to defer
    it again
- `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled_sparse1_input_echo_cap`
  kept the sparse-switch follow-up in the right narrow seam, but it still stayed deferred:
  - it moved post-input-ready protection into an input-triggered, task-scoped focused-write cap
    instead of leaving it as a scheduler-global mode
  - it improved some `2 visible` and dense interactive/render medians relative to the older grace
    variant
  - but it still regressed sparse recent-hidden switching, reopened sparse bulk long-task/render
    pressure, and did not beat the broad benchmark cleanly enough to replace it
- `shape_split_visible_budget_dense_pressure_sparse1_dense4_merged` showed that merging sparse and
  dense fixes directly is not sufficient; it looked directionally sensible in isolation, but the
  merged policy reopened dense bulk collapse badly enough to reject outright

Recommendation:

- keep `product_default` as the shipped policy
- keep `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled` as the current
  broad comparison point, with `product_default` still treated as the shipped baseline
- keep the sparse switch echo-grace and sparse input-echo-cap paths as diagnostic probes, not
  rollout candidates
- keep the older dense-only reference and the earlier shape-split reference as comparison points,
  not rollout candidates
- do not merge sparse and dense fixes again until each fix wins independently in its target shape
- the next visible-path work should stay narrow and solve two remaining problems separately:
  - recover sparse recent-hidden switching without assuming a short app echo window or a one-shot
    focused queued-write cap is sufficient
  - improve dense interactive responsiveness without giving back the dense switch and bulk gains

### H. Structural Heavy-Load Live-Surface Caps

Observed result:

- the new `frozen-visible` surface tier and exact-count additional-live-visible caps were the right
  architectural seam to measure, but the first always-on structural caps are still deferred
- clean uncontended `24 terminals / 4 visible` screen runs showed that
  `structural_heavy_load_live_surface_cap` is not a safe direct win:
  - dense `interactive_verbose` round-trip timed out and frame-gap/long-task pressure worsened
  - dense `bulk_text` regressed catastrophically, including multi-second frame-gap p95
- `structural_heavy_load_live_surface_cap_tight` proved a more interesting tradeoff:
  - dense `bulk_text` improved to `frame-gap p95=150.00ms`, `longtasks=127.00ms`,
    `render p95=2325.00ms`
  - dense `interactive_verbose` still regressed badly enough to block rollout
  - aggressive lifecycle changes can age a prepared `recent_hidden_switch` target out of the
    expected state before measurement starts
- the clean dense reference still remains
  `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled` in
  `phase-dense-reference-clean-2026-03-24-r1`:
  - dense `interactive_verbose` round-trip improved from `459.20ms` to `241.20ms`
  - dense `bulk_text` improved from `frame-gap p95=200.10ms`, `longtasks=146.00ms` to
    `150.00ms`, `112.00ms`

Recommendation:

- keep `product_default` as shipped
- keep `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled` as the current
  broad dense-load comparison point
- keep both structural heavy-load live-surface-cap variants deferred
- revisit `frozen-visible` only if it is coupled to a smarter pressure- or intent-armed freeze
  policy rather than an always-on exact-count cap
- screen future lifecycle-heavy variants on clean dense `interactive_verbose` and `bulk_text`
  runs before trusting mixed-profile or parallel spot checks

### I. Guarded Dense-Overload Mode

Observed result:

- the new guarded dense-overload seam is directionally useful for the heavy-load case, but it is
  still deferred as an automatic product mode
- the clean dense screen in
  `phase-guarded-dense-overload-dense-screen-2026-03-24-r1`
  showed that `guarded_dense_overload_reference` can improve dense `recent_hidden_switch` and
  dense `bulk_text` versus `product_default`:
  - `recent_hidden_switch`: `439.20ms -> 410.00ms`
  - `bulk_text frame-gap p95`: `233.30ms -> 200.00ms`
  - `bulk_text longtasks`: `1117.00ms -> 344.00ms`
  - `bulk_text render p95`: `3451.20ms -> 3034.10ms`
- the same candidate is still not inert enough outside dense overload. The sparse/few-visible
  guard check in
  `guarded_dense_overload_reference visible=1`
  and
  `guarded_dense_overload_reference visible=2`
  still regressed:
  - `1 visible recent_hidden_switch`: `485.10ms -> 1374.10ms`
  - `2 visible recent_hidden_switch`: `464.30ms -> 817.20ms`
  - `2 visible bulk_text`: `frame-gap p95=166.60ms -> 266.60ms`,
    `longtasks=267.00ms -> 1678.00ms`
- `guarded_dense_overload_reference_frozen_visible` is deferred even more clearly:
  - the clean dense screen regressed to `recent_hidden_switch=3317.70ms`,
    `interactive_verbose=4741.20ms`, and `bulk_text render p95=5495.20ms`
  - the sparse/few-visible check also produced severe few-visible bulk collapse

Recommendation:

- keep `product_default` as shipped
- keep `shape_split_visible_budget_dense_pressure_interactive4_pressure_scaled` as the current
  broad dense-load comparison point
- treat `guarded_dense_overload_reference` as a dense-only benchmark reference, not as an
  automatic product mode yet
- keep `guarded_dense_overload_reference_frozen_visible` deferred
- if guarded dense-overload work is revisited, require both:
  - a clean dense `4 visible` screen
  - a sparse/few-visible inertness check that proves the guard really stays out of the way when
    overload is absent or when selected recovery is active

## Ideas That Should Stay Deferred Or Avoided

These ideas may look attractive, but they do not currently fit the repo direction well:

- speculative local echo as the default terminal typing path
- moving control ownership into renderer heuristics
- letting dialogs own takeover policy or timeout behavior
- making transport adapters silently rewrite domain meaning
- using destructive full terminal reset as the default reconnect strategy
- optimizing for one benchmark by weakening lifecycle correctness

## Recommended Priority Order

1. command-class transport model
2. control ownership and resize-authority simplification
3. takeover state-machine formalization
4. differential restore and non-destructive reconnect
5. model-based multi-client invariant testing
6. invariant-aware stress harnesses
7. stricter cleanup utilities and singleton reset discipline
8. conditional binary-input or deeper replay work only if metrics still demand it

## Success Criteria For Future Work

Future slices in this area should leave the system with:

- fewer overlapping ownership models
- fewer cleanup paths that rely on timing luck
- explicit transport semantics per command type
- explicit state-machine transitions for takeover and recovery
- measurable interactive vs bulk latency budgets
- invariant-aware stress coverage for multi-client churn
- enough diagnostics to explain field failures without guesswork

The next iteration should make the system simpler and more explicit, not merely faster in one
narrow benchmark.
