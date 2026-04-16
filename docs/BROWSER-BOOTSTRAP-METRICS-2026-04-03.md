# Browser Bootstrap Metrics 2026-04-03

This note tracks the browser-startup measurement workflow after the cold-bootstrap/reconnect split.

## Goal

Measure cold browser startup separately from reconnect restore and keep the next architecture step
evidence-driven.

## Manual Benchmark Command

Run the manual browser-lab benchmark with:

```bash
RUN_BROWSER_STARTUP_METRICS=1 npm run test:browser:run -- tests/browser/browser-startup-metrics.spec.ts --project chromium --workers=1
```

If the branch cannot currently produce fresh browser artifacts, use the shared skip-build contract:

```bash
PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK=1 RUN_BROWSER_STARTUP_METRICS=1 npm run test:browser:file -- tests/browser/browser-startup-metrics.spec.ts --project chromium --workers=1
```

The benchmark prints a JSON payload with:

- `attachTrace`
  - queued-to-start, start-to-bind, and bind-to-ready timing for the selected terminal on cold
    bootstrap runs
- `replayTrace`
  - the selected terminal's most recent visible recovery replay after reconnect churn
  - may be `attach` or `reconnect` depending on whether browser sync rebinds the live session
- `bootstrap`
  - buffered bootstrap event/snapshot counts and the last bootstrap duration
- `browserStartup`
  - current mode
  - current tier
  - cold-bootstrap/reconnect start counts
  - cold-bootstrap/reconnect last duration
  - tier entry counts
  - tier last reached timings
- `browserSync`
  - reconnect sync scheduling/completion counts and the last browser-sync duration
- `terminalRecovery`
  - recovery request counts
  - recovery kind counts
  - stable reveal wait counts
  - visible steady-state snapshot counters
- `terminalStartupPaint`
  - selected logical ready
  - selected paint ready
  - visible-sibling and hidden startup counters

## Signals That Matter

The metrics are useful only if they preserve the architecture split between cold bootstrap and
reconnect restore. The fields to watch are:

- `browserStartup.modeCompleteCounts`
  - proves whether the run completed in `cold-bootstrap` or `reconnect-restore`
- `browserStartup.tierCounts` and `browserStartup.tierLastReachedMs`
  - show whether the browser still reached the expected shell, summary, selected-task, selected-terminal, and background tiers
- `browserSync.started`, `browserSync.completed`, `browserSync.failed`
  - show whether reconnect restore actually completed without transport failure
- `terminalRecovery.kindCounts.snapshot`
  - should stay `0` for the cold-bootstrap cases in this benchmark
- `attachTrace` and `replayTrace`
  - show whether the selected terminal reached readiness through cold bootstrap or through replay after reconnect churn
- `terminalStartupPaint`
  - keeps the logical-ready and paint-ready signals visible so the note does not regress into a mode-only summary

## What To Compare

Capture the same experiment:

1. before changing cold bootstrap payload shape
2. after switching cold bootstrap to the backend-owned projection
3. after any selected-terminal attach optimization

## Current Status

- cold bootstrap and reconnect restore are already separated
- the browser-lab benchmark hook is now in
  `tests/browser/browser-startup-metrics.spec.ts`
- cold bootstrap now consumes a typed backend-owned workspace projection instead of
  `workspaceStateJson`
- capture is still manual because this is a diagnostic experiment, not a default CI gate

## Latest Capture: 2026-04-16

Command used locally:

```bash
PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK=1 RUN_BROWSER_STARTUP_METRICS=1 npm run test:browser:run -- tests/browser/browser-startup-metrics.spec.ts --project chromium --workers=1
```

Successful capture summary:

- both cold-bootstrap cases completed in `cold-bootstrap`
- both cold-bootstrap cases kept `terminalRecovery.kindCounts.snapshot = 0`
- the reconnect-restore case completed in `reconnect-restore`
- browser sync completed successfully during reconnect restore
- the reconnect case did not re-enter the cold-start shell/summary/selected-task tier sequence
- the selected visible terminal remained the only place where recovery replay details mattered, and
  that replay was treated as a reconnect-visible signal rather than evidence of a cold-start
  regression

Measured cases:

### Cold Bootstrap, Prompt-Ready Fixture

- bootstrap completion: `228ms`
- cold-bootstrap completion: `244ms`
- selected terminal logical ready: `141.0ms`
- selected terminal paint ready: `158.8ms`
- selected attach trace:
  - queued-to-start: `22.2ms`
  - start-to-bind: `70.3ms`
  - bind-to-ready: `76.7ms`
  - readyAt: `1,070.5ms`
- terminal recovery:
  - `kindCounts.snapshot = 0`
  - `requestCounts.attach = 0`
  - `requestCounts.reconnect = 0`

### Cold Bootstrap, Startup-Buffer Fixture

- bootstrap completion: `234ms`
- cold-bootstrap completion: `242ms`
- selected terminal logical ready: `140.3ms`
- selected terminal paint ready: `163.2ms`
- selected attach trace:
  - queued-to-start: `19.9ms`
  - start-to-bind: `64.5ms`
  - bind-to-ready: `82.9ms`
  - readyAt: `1,142.2ms`
- terminal recovery:
  - `kindCounts.snapshot = 0`
  - `requestCounts.attach = 0`
  - `requestCounts.reconnect = 0`

### Reconnect Restore, Browser Transport Churn

- reconnect-restore completion: `70ms`
- browser sync completion: `48ms`
- replay trace:
  - `reason = reconnect`
  - `recovery.kind = noop`
  - `requestStateBytes = 276`
  - `restoreTotalMs = 94.2`
  - `resumeMs = 14.3`
- terminal recovery:
  - `kindCounts.snapshot = 1`
  - `requestCounts.attach = 1`
  - `requestCounts.reconnect = 1`
- cold-start tiers stayed at `0` during reconnect restore

## Previous Capture: 2026-04-08

```bash
PARALLEL_CODE_SKIP_BROWSER_BUILD_ARTIFACT_CHECK=1 RUN_BROWSER_STARTUP_METRICS=1 npm run test:browser:run -- tests/browser/browser-startup-metrics.spec.ts --project chromium --workers=1
```

Measured cases:

### Cold Bootstrap, Prompt-Ready Fixture

- bootstrap completion: `209-1,014ms`
- cold-bootstrap completion: `209-574ms`
- summary tier reached: `51-114ms`
- selected-task tier reached: `61-145ms`
- selected terminal logical ready: `129.0-399.8ms`
- selected terminal paint ready: `146.7-428.2ms`
- selected attach trace:
  - queued-to-start: `13.7-35.0ms`
  - start-to-bind: `69.3-330.2ms`
  - bind-to-ready: `69.8-378.1ms`

### Cold Bootstrap, Startup-Buffer Fixture

- bootstrap completion: `198-253ms`
- cold-bootstrap completion: `211-407ms`
- summary tier reached: `53-67ms`
- selected-task tier reached: `64-81ms`
- selected terminal logical ready: `126.2-233.2ms`
- selected terminal paint ready: `146.2-325.1ms`
- selected attach trace:
  - queued-to-start: `13.7-17.0ms`
  - start-to-bind: `59.8-148.0ms`
  - bind-to-ready: `159.9-426.2ms`

### Reconnect Restore, Browser Transport Churn

- reconnect-restore completion: `44-69ms`
- browser sync completion: `36-58ms`
- selected terminal logical ready after churn: `636.3-723.5ms`
- selected terminal paint ready after churn: `638.5-725.1ms`
- selected visible-terminal replay trace:
  - recovery reason: `attach`
  - recovery kind: `snapshot`
  - recovery fetch: `25.9-65.9ms`
  - apply: `3.4-8.0ms`
  - restore total: `93.9-175.7ms`
  - resume: `5.5-8.6ms`
- reconnect did not re-enter the cold-start shell/summary/selected-task tier sequence, which is the
  expected contract for the lightweight reconnect path
- in this transport-churn harness the visible selected terminal recovered through a fresh `attach`
  replay instead of a `reconnect` replay, which is acceptable when browser sync rebinds the live
  session during reconnect

## Diagnosis

- cold shell and summary work are no longer the dominant cost in the measured browser path
- the heavier visible-terminal startup-buffer fixture barely moved cold-start completion, which is
  more evidence against another shell/bootstrap rewrite as the next high-ROI step
- reconnect control-plane restore is already lightweight; it is not the dominant bottleneck
- selected-terminal readiness remains the longest visible part of startup, including the visible
  recovery tail after reconnect churn
- the cold selected-terminal slice improved the selected-first path without disturbing shell
  bootstrap, but reconnect churn still has a much longer visible tail than the recovery fetch/apply
  itself
- attach-trace evidence still suggests queueing and initial bind are relatively small compared with
  the post-bind path to ready/paint, so the next isolated experiment should target selected-terminal
  post-bind readiness and presentation stabilization rather than another browser bootstrap
  projection change
- reconnect metrics need to be read as "visible selected recovery after transport churn" rather than
  "always a reconnect replay", because the live session may legitimately recover through `attach`
  when browser sync rebinds the visible terminal
- a follow-up rerun after clearing the replay traces before reconnect produced the same qualitative
  result: the visible selected terminal still recovered through an `attach` snapshot replay, and
  the dominant remaining cost stayed in the selected-terminal visible tail rather than the control
  plane restore itself
- a second rerun after seeding terminal recovery from the actual browser transport state preserved
  the same conclusion; it changed the absolute cold-start timings somewhat, but the dominant
  remaining bottleneck was still the visible selected-terminal tail after reconnect churn

## Next Bounded Experiment

Use the selected-terminal path as the next benchmark/optimization seam:

1. keep the current cold-bootstrap architecture unchanged
2. instrument reconnect-relative selected-terminal milestones further if needed:
   attach queued, attach start, bind complete, recovery apply settled, logical ready, paint ready
3. optimize only the visible selected-terminal post-bind/presentation path, especially after
   transport churn
4. rerun this same benchmark to compare selected logical-ready and paint-ready timing
