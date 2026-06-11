# Browser Bootstrap Metrics 2026-04-03

This note tracks the browser-startup measurement workflow after the cold-bootstrap/reconnect split.

## Goal

Measure cold browser startup separately from reconnect restore and base the next architecture step
on startup data.

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
  that replay was treated as a reconnect-visible signal, not as a cold-start regression

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
  replay instead of a `reconnect` replay; that is acceptable when browser sync rebinds the live
  session during reconnect

## Diagnosis

- cold shell and summary work are no longer the dominant cost in the measured browser path
- the heavier visible-terminal startup-buffer fixture barely moved cold-start completion, which is
  evidence against another shell/bootstrap rewrite as the next bounded step
- reconnect control-plane restore is already lightweight; it is not the largest measured cost
- selected-terminal readiness remains the longest visible part of startup, including the visible
  recovery tail after reconnect churn
- the cold selected-terminal slice improved the selected-first path without disturbing shell
  bootstrap, but reconnect churn still has a much longer visible tail than the recovery fetch/apply
  itself
- attach-trace evidence still suggests queueing and initial bind are relatively small compared with
  the post-bind path to ready/paint, so the next isolated experiment should target selected-terminal
  post-bind readiness and presentation stabilization, not another browser bootstrap projection
  change
- reconnect metrics need to be read as "visible selected recovery after transport churn" rather than
  "always a reconnect replay", because the live session may legitimately recover through `attach`
  when browser sync rebinds the visible terminal
- a follow-up rerun after clearing the replay traces before reconnect produced the same qualitative
  result: the visible selected terminal still recovered through an `attach` snapshot replay, and
  the largest remaining cost stayed in the selected-terminal visible tail rather than the control
  plane restore itself
- a second rerun after seeding terminal recovery from the actual browser transport state preserved
  the same conclusion; it changed the absolute cold-start timings somewhat, but the largest
  remaining cost was still the visible selected-terminal tail after reconnect churn

## Next Bounded Experiment

Use the selected-terminal path as the next benchmark/optimization seam:

1. keep the current cold-bootstrap architecture unchanged
2. instrument reconnect-relative selected-terminal milestones further if needed:
   attach queued, attach start, bind complete, recovery apply settled, logical ready, paint ready
3. optimize only the visible selected-terminal post-bind/presentation path, especially after
   transport churn
4. rerun this same benchmark to compare selected logical-ready and paint-ready timing

## Performance Program Phase 0 Baseline: 2026-06-10

This is the measurement-harness baseline for the five-item boot/attach/resync performance program.
Every program item appends a before/after scorecard against these numbers. The harness landed with
zero production behavior changes:

- `scripts/profile-server-boot.mjs` (`npm run profile:server:boot`) boots the built server against
  a synthetic N-task `.server-data` over real temp git worktrees and emits a scorecard JSON
- the `gitSubprocessCount` runtime-diagnostics gauge (fed by the `electron/ipc/git-exec.ts`
  counting wrapper) is polled through `get_backend_runtime_diagnostics`
- the `dispatch-release` scenario joined `npm run benchmark:terminal:attach-recovery`
- the blip-reconnect socket byte counter lives in `tests/harness/reconnect-byte-counter.ts` with a
  smoke lock in `tests/contracts/delta-resync.contract.test.ts` (no budget asserted yet)

### Prior review evidence (recorded for comparison)

From the program's review evidence captures (committed builds, real `.server-data`, synthetic
12-task workspace):

- server boot-to-listen: `978ms` at 2 tasks, `4,009ms` at 12 tasks
- cold-bootstrap HTTP: `511ms` idle first call, `3,664ms` during the 12-task boot storm
- git subprocesses in the first ~10s after a 12-task boot: `689`
- selected terminal ready (cold bootstrap, prompt-ready fixture): `1,070ms` (`readyAt` above)
- coordinator persistence: `59ms`/event full-state synchronous persist

### Boot profiler scorecard (this capture)

Command:

```bash
npm run build:server && node scripts/profile-server-boot.mjs --out artifacts/server-boot-profile/baseline-2026-06-10.json
```

3 boot iterations per task count, medians reported, `PORT=0`, 10s git-subprocess window
(darwin arm64, 10 cores, node v24.16.0):

- 2 tasks:
  - boot-to-listen: median `2,983.3ms` (samples `2,612.5 / 2,983.3 / 3,255.8`)
  - cold bootstrap during boot: median `709.4ms` (samples `709.4 / 622.8 / 851.8`)
  - settled cold bootstrap: median `63.7ms` (samples `91.6 / 19.8 / 63.7`)
  - gitSubprocessCount in the first 10s: median `546` (samples `579 / 546 / 461`)
- 12 tasks:
  - boot-to-listen: median `3,898.6ms` (samples `2,894.3 / 3,898.6 / 4,133.6`)
  - cold bootstrap during boot: median `4,318.2ms` (samples `3,054.5 / 7,898.6 / 4,318.2`)
  - settled cold bootstrap: median `1,544.4ms` (samples `5,004.1 / 644.7 / 1,544.4`)
  - gitSubprocessCount in the first 10s: median `536` (samples `721 / 365 / 536`)
- boot-to-listen ratio 12-task vs 2-task: `1.31`
- `report_client_task_focus` is not yet a server channel (`focusSignalSupported: false`); the
  profiler records focus-driven refresh latency once the boot-pipeline item lands it

This capture's absolute 2-task boot is slower than the review evidence run, but the storm shape
reproduces: the 12-task boot keeps the first cold bootstrap above 4s and the settled 12-task cold
bootstrap above 1.5s, against a ~64ms 2-task settled call.

### Attach benchmark baseline (this capture)

`npm run benchmark:terminal:attach-recovery`, 24-terminal fixtures, synthetic 8ms holds:

- `reprioritized-pending`: `maxActive=1`, queue span `184ms` (the serial-collapse baseline the
  attach-pipeline item must lift to `maxConcurrentAttaches >= 2` and span `< 60ms`)
- `dispatch-release` (new scenario, slot released at dispatch instead of resolve):
  queue span `0ms` at fake-timer granularity, `maxActive=24`

### Blip-reconnect byte baseline (this capture)

`tests/contracts/delta-resync.contract.test.ts` smoke fixture (toy scale, not 12-task):
`1,609` bytes / 6 messages between re-auth and the `state-bootstrap` handshake-complete marker.
The delta-resync item re-baselines this at 12-task scale before asserting its `< 5KB` budget.

## Boot-Pipeline Item Scorecard: 2026-06-10

After the snapshot-first, demand-driven backend boot landed (persisted `derived-state.json`
hydration, the prioritized backend work queue with `ReportClientTaskFocus` focus signals, watchers
restored without blanket refreshes, the post-listen coordinator runtime loader, and precompressed
static delivery), measured on the same machine and method as the Phase 0 baseline:

```bash
npm run prepare:browser-artifacts && node scripts/profile-server-boot.mjs --out artifacts/server-boot-profile/boot-pipeline-2026-06-10.json
```

3 boot iterations per task count, medians reported, `PORT=0`, 10s git-subprocess window
(darwin arm64, 10 cores, node v24.16.0):

- 2 tasks:
  - boot-to-listen: median `2,194.4ms` (baseline `2,983.3ms`)
  - cold bootstrap during boot: median `278.6ms` (baseline `709.4ms`)
  - settled cold bootstrap: median `7.0ms` (baseline `63.7ms`)
  - gitSubprocessCount in the first 10s: median `2` (baseline `546`)
- 12 tasks:
  - boot-to-listen: median `2,286.4ms` (baseline `3,898.6ms`)
  - cold bootstrap during boot: median `360.0ms` (baseline `4,318.2ms`)
  - settled cold bootstrap: median `11.9ms` (baseline `1,544.4ms`)
  - gitSubprocessCount in the first 10s: median `12` (baseline `536`)
- boot-to-listen ratio 12-task vs 2-task: `1.04` (baseline `1.31`; target `<= 1.2x` met)
- `report_client_task_focus` is now a live server channel (`focusSignalSupported: true`)

Against the program acceptance criteria for this item:

- 12-task boot-to-listen is `1.04x` the 2-task boot (target `<= 1.2x`)
- first cold bootstrap during a 12-task boot is `360ms` (target `< 600ms`; idle warm path stays
  cached at `~7-12ms`)
- the remaining 12 git subprocesses in the first 10s are the per-task watcher `resolveGitDir`
  probes; the per-task refresh storm (4-6 status execs plus 4-pipeline convergence fan-out, twice)
  is gone (target `< 50`, baseline `536-689`)
- main bundle wire transfer: `dist/assets/index-*.js.gz` is `216,671` bytes (target `< 250KB`,
  baseline `693,248` identity bytes), asserted by `node scripts/compress-dist-assets.mjs --check`
  alongside the terminal-session modulepreload link in `dist/index.html`

CI-stable ordering/count locks (not wall-clock) live in `server/boot-pipeline.test.ts`: bounded
subprocess count at listen, hydrated cold-bootstrap categories with exact identities, the no-retry
coordinator first call, focused-task refresh ahead of untouched background tasks, and
hydrated-to-refreshed `stateVersion` monotonicity. The `< 600ms` cold-bootstrap-during-boot number
stays a lab scorecard figure with a joint re-check after the bootstrap-payload item removes the
remaining `listAgents` probing from the handler path.

## Bootstrap-Payload Item Scorecard: 2026-06-10

After the minimal cold bootstrap, parallel renderer startup, and revision-keyed reconnect landed
(`listAgents()` probing removed from the cold-bootstrap handler in favor of the sticky
`agent-availability` server-state category, plan contents and project-path existence folded into
the cold-bootstrap payload, the cold-bootstrap fetch moved ahead of window chrome, and the
reconnect snapshot made revision-keyed with the legacy `appStateJson` duplicate dropped), measured
on the same machine and method as the prior scorecards:

```bash
npm run build:server && node scripts/profile-server-boot.mjs --out artifacts/server-boot-profile/bootstrap-payload-2026-06-10.json
```

3 boot iterations per task count, medians reported, `PORT=0`, 10s git-subprocess window
(darwin arm64, 10 cores, node v24.16.0):

- 2 tasks:
  - boot-to-listen: median `1,546.7ms` (boot-pipeline scorecard `2,194.4ms`)
  - cold bootstrap during boot: median `102.3ms` (boot-pipeline scorecard `278.6ms`)
  - settled cold bootstrap: median `2.3ms` (samples `2.4 / 2.3 / 2.0`; boot-pipeline scorecard
    `7.0ms`)
  - gitSubprocessCount in the first 10s: median `2` (unchanged)
- 12 tasks:
  - boot-to-listen: median `1,684.7ms` (boot-pipeline scorecard `2,286.4ms`)
  - cold bootstrap during boot: median `103.8ms` (boot-pipeline scorecard `360.0ms`)
  - settled cold bootstrap: median `2.6ms` (samples `2.6 / 2.9 / 2.6`; boot-pipeline scorecard
    `11.9ms`)
  - gitSubprocessCount in the first 10s: median `12` (unchanged)
- boot-to-listen ratio 12-task vs 2-task: `1.09` (target `<= 1.2x` still met)
- `report_client_task_focus` stays a live server channel (`focusSignalSupported: true`)

Against the program acceptance criteria for this item:

- idle cold-bootstrap handler: the settled full HTTP round trip is `2.3-2.6ms` (target `< 50ms`,
  pre-program baseline `511ms`); the handler is now synchronous by construction, structurally
  proven by the hung-prober test in `electron/ipc/system-handlers.test.ts` (zero process spawns
  or awaits on the handler path)
- first cold bootstrap during a 12-task boot: `103.8ms` (target `< 600ms`; was `360ms` after the
  boot-pipeline item with `listAgents` probing still inline, `3,664ms` pre-program)
- tab-refresh critical-path round trips: `3`
  - before: page load -> `GetBrowserColdBootstrap` (handler blocked on inline `listAgents`
    probing, ~330ms idle / 1s+ on nvm-heavy shells, re-paid every 5s by the unavailable-agent
    TTL) -> selected-terminal attach round trip(s), with plan content and `CheckPathsExist`
    validation as separate follow-up round trips and the fetch serialized behind window
    chrome/runtime registration
  - after: page load -> `GetBrowserColdBootstrap` (probe-free, started before window chrome,
    carrying the workspace projection, server-state categories including `agent-availability`,
    `planContents`, and `projectPathsExist`) -> selected-terminal attach round trip(s);
    `validateProjectPaths` survives only as a delayed background reconciliation refresh, proven
    by the exactly-one-awaited-fetch test in `src/app/desktop-session.test.ts`
- reconnect with a matching `knownWorkspaceRevision` ships neither `workspaceStateJson` nor
  `appStateJson` (baseline: two full serialized copies on every full restore), counted by the new
  `reconnectSnapshots.revisionSkips` diagnostics gauge; the saved-state cache is revision-keyed
  with no TTL (every save invalidates it), so warm reconnect storms stop re-reading and
  re-serializing saved state every 5s
- no item-1 number regressed: subprocess counts are identical, boot-to-listen improved on both
  task counts, the 12/2-task ratio stayed within target (`1.04` -> `1.09`, target `<= 1.2x`;
  the ratio rose only because the 2-task denominator improved more than the 12-task numerator),
  and `server/boot-pipeline.test.ts` plus the compress-dist `--check` gate stay green unchanged

Speculative selected-terminal attach is descoped to intent publication plus the confirm/discard
lifecycle in this item (no prewarm consumer ships); the `< 500ms` page-load-to-selected-terminal
target remains a joint checkpoint with the attach-pipeline item's single-RTT attach.

## Attach-Pipeline Item Scorecard: 2026-06-10

Capture after the attach-pipeline item (single-round-trip `AttachTerminalSession`, slot release
at dispatch with the drain-loop break removed, cursor-first two-phase recovery with the
server-owned batch pause, flush-time backend scans plus `serializeLatest`, browser outbound
lanes with focused-channel priority, lease prefetch on switch intent, deferred cold-hidden
non-shell renderer attach), measured on the same machine and method as the prior scorecards.

Selected-terminal attach round trips (proven by count, not wall clock):

- exactly one backend round trip from attach start to interactive for fresh and existing-session
  attaches, with zero `SpawnAgent`/`PauseAgent`/`ResumeAgent`/`GetTerminalRecoveryBatch` invokes
  on the path (`terminal-session.test.tsx` round-trip counting test; baseline 4-5 round trips:
  channel bind, `SpawnAgent`, pause, recovery fetch, resume)
- batched restores carry zero per-terminal pause/resume invokes; the pause release is one
  fire-and-forget message after apply (`terminal-recovery-runtime.test.tsx`)

Attach scheduler concurrency (`npm run benchmark:terminal:attach-recovery`, 48 iterations,
synthetic 8ms holds, asserted in the benchmark):

- `reprioritized-pending` (background fleet plus a pending promoted-foreground candidate):
  `maxActive=2` at 6/12/24/32 terminals (baseline `maxActive=1`; 24-terminal queue span
  88ms vs 184ms baseline)
- `dispatch-release` (slots released at attach dispatch): 24-terminal queue span `0ms`
  (asserted `< 60ms`; baseline 96-184ms with slots held across round trips)

Reconnect restore bytes (cursor-first):

- cursor-hit reconnect request uploads `requestStateBytes: 0` and the response is `noop`
  (startup-metrics reconnect capture: `restoreTotalMs 12.9ms`, `revealSettleMs 0`,
  `pauseMs 0`, `resumeMs 0`; baseline up to 2MB rendered-tail upload per terminal plus
  2N pause/resume round trips) — a >99% request-byte reduction in the cursor-hit case
- reconnect snapshots are capped at the attach byte limits (server tests); the `tail-needed`
  phase-two tail is bounded at 64KB
- `terminal-restore.spec.ts` keeps `requestStateBytes === 0` and zero snapshot recoveries
  asserted for reload shell reattach (15/15 green)

Selected-terminal queued-to-interactive (gated startup-metrics lane, this machine):

- 1-terminal fixture: `137.9ms` (budget 250ms)
- 8-terminal fixture: `204.3ms` (budget 350ms)
- 24-terminal fixture: `587-671ms` (budget 800ms; see the docs/TESTING.md re-baseline note —
  the cold 24-task fixture pays a real fresh PTY spawn, plan target 500ms assumed
  attach-to-existing)
- pre-program baseline: ~1,070ms selected-terminal ready

Echo canaries with the lane scheduler enabled:

- `terminal-steady-state-responsiveness.spec.ts` 5/5 green (sendToEcho p95 bars 24-32ms kept),
  `terminal-noisy-background.spec.ts` green
- `server/terminal-latency.test.ts` 33/33 green across 3 consecutive runs with echo RTT
  max `0.7-0.9ms` (the prior flaky bar was max 34.1ms vs 25ms; the hot-loop change moved
  per-chunk decode/supervision/mirror work to flush time off the echo path); the previously
  timing-out `RecoveryRequired` byte-limit case passes in ~800ms

No regression of the items 1-2 scorecard (same profiler method,
`node scripts/profile-server-boot.mjs`, 3 iterations, medians):

- 2 tasks: boot-to-listen `1,700.6ms` (was `1,546.7ms`, within run-to-run noise),
  cold bootstrap during boot `129.5ms`, settled cold bootstrap `2.7ms`,
  gitSubprocessCount `2`
- 12 tasks: boot-to-listen `1,529.5ms` (was `1,684.7ms`), cold bootstrap during boot `98ms`,
  settled cold bootstrap `2.4ms`, gitSubprocessCount `12`
- 12/2-task boot ratio `0.90` (target `<= 1.2x`); focus signal still live

## Delta-Resync Item Scorecard: 2026-06-10

Measurement entrypoints: `tests/contracts/delta-resync.contract.test.ts` (socket byte counting
between re-auth and handshake-complete via `tests/harness/reconnect-byte-counter.ts`) and the
`electron/coordinator/service.test.ts` emit-latency instrumentation. Both are CI-asserted; no
browser lab pass was required for these budgets.

Blip reconnect payload (12-subtask coordinator fixture, same fixture for both paths):

- no-change blip reconnect with current `ResyncVersionMap` + `agentsVersion` +
  `serverInstanceId`: `824 bytes` total on the control socket
  (`control-replay-batch` 169B + stale-category bootstrap 655B carrying only
  `peer-presence`/`remote-status`), asserted `< 5KB`
- legacy client on the same fixture (full 12-category bootstrap + per-event replay):
  `49,443 bytes` — a ~60x reduction for the versioned path
- pre-item baseline also re-sent every coordinator event twice (ipc-event + coordinator-event)
  and shipped a full ~156KB run snapshot per mutation through the replay ring; both multipliers
  are gone (single `coordinator-event` channel, entity-sized granular events, latest-wins ring
  compaction per entity key)

Coordinator persist coalescing (50-mutation burst, multi-MB state fixture):

- zero synchronous persists remain on the emit path at all (`fs.writeFileSync` spy-asserted:
  0 calls during the burst; baseline: 59ms synchronous whole-world persist per event, ~3s
  blocked backend per burst)
- per-event emit latency measured `p90 0.35ms` / typical max `~1.7ms` isolated (the CI lane
  asserts p90 < 5ms so loaded parallel test workers cannot flake the budget with GC noise; an
  isolated 19ms GC outlier was observed once under the full 300-file suite)
- saves coalesce to one trailing debounced async write (<= ~1 save per 2s under sustained
  bursts, fake-timer asserted)

Restart and durability locks (CI-asserted):

- server-restart reconnect takes the full-bootstrap path via the `serverInstanceId` mismatch
  (contract case; presented per-boot versions are never compared across instances)
- one corrupt run in `coordinator-state.json` loses only that run (`salvaged`,
  `droppedRunCount: 1`) and never touches credential files; unreadable primary falls back to
  `.bak` with a `.corrupt-<ts>` quarantine copy
- a 2-minute no-change disconnect resolves through `GetBrowserReconnectStatus` only (no
  `GetBrowserReconnectSnapshot`, no full restore) — the 30s wall-clock warm window is gone
- task-command leases survive a 2s blip (no controller-null snapshot), takeover-during-grace
  wins and is never resurrected, never-connected automation clientIds keep immediate prune, and
  the wake liveness probe detects a zombie-OPEN socket within its 2s deadline with a 0ms
  fast-reconnect

No regression: items 1-3 deterministic gates stay green (`server/boot-pipeline.test.ts`,
reconnect-replay/control-lease/control-plane-stress/remote-status/task-command-takeover
contracts, `npm run test:node:coordinator:e2e` 32/32 with predicate-only churn for the granular
event vocabulary).

### Delta-resync verification capture: 2026-06-11

Review verification of this item found and fixed one real regression and re-ran the full gate:

- the legacy per-event replay path delivered compacted (non-contiguous) windows, which misfired
  the remote shell's per-event gap detection; the remote answers gaps with a hard reconnect and
  its own churn re-compacts the window, so every `/remote` session wedged in a reconnect loop
  (4/4 remote browser-lab tests red). Fixed at the transport owner: a non-contiguous window now
  degrades to the `replay-truncated` signal with no per-event replay, and the shared client core
  adopts the signal's `latestSeq` wholesale (`electron/remote/ws-transport.ts`,
  `src/lib/websocket-client.ts`); locked by ws-transport/websocket-client unit tests, a
  delta-resync contract case, and the green remote browser lane
- client-side restart soundness: per-category version trackers now reset when the
  state-bootstrap `serverInstanceId` changes, so a restarted server's lower per-boot bootstrap
  versions are accepted instead of wedging the categories until reload
  (`resetServerStateVersionTrackingForInstanceChange`)
- `run-meta-upserted` moved to its own replay-ring compaction slot, and the coordinator store
  applier adopts `categorySeq` only for fully applicable events

Re-measured on the same machine and method (3 iterations, medians,
`artifacts/server-boot-profile/delta-resync-verify-2026-06-11.json`):

- 2 tasks: boot-to-listen `1,690.5ms`, cold bootstrap during boot `107.0ms`, settled cold
  bootstrap `2.3ms`, gitSubprocessCount `2`
- 12 tasks: boot-to-listen `1,714.9ms`, cold bootstrap during boot `101.2ms` (target `< 600ms`),
  settled cold bootstrap `2.8ms`, gitSubprocessCount `12`; 12/2-task ratio `1.01`
  (target `<= 1.2x`); `focusSignalSupported: true`
- no-change blip reconnect: `824 bytes` (asserted `< 5KB`); legacy full bootstrap `49,443 bytes`
  on the same fixture
- 50-mutation burst: `fs.writeFileSync` spy 0 calls, emit latency p90 `0.289ms` /
  max `0.558ms` isolated
- browser proof: `npm run test:browser:canaries` 7/7 and `npm run test:browser:remote` 4/4 green
  on the rebuilt artifacts

## Perceived-Latency Item Scorecard: 2026-06-11 (item 5)

Capture after the perceived-latency layer (startup skeleton + workspace-shape cache, cached
terminal placeholder tail under the loading overlay, pre-session input buffering with the
queued-keys indicator, optimistic task creation, coordinator rail alert/spawn-ack/optimistic
pause, coordinator stale-run attention + title-bar Resume, persistent error toasts, shipped
`sidebarIntentPrewarmDelayMs: 120` and keyboard selection-intent prewarm), including the review
verification fixes:

- workspace-shape cache hardening: persistence never schedules a write while
  `isAppStartupPresentationPending()` (the subscription registers before the awaited cold
  bootstrap, so a >1s bootstrap would have clobbered the returning user's cached shape with the
  empty store), an empty shape is never cached (persisting an emptied workspace removes the
  entry), and a previously cached empty shape reads as no cache — first-run users keep
  onboarding (`workspace-shape-cache.test.ts`, new `workspace-shape-cache-persistence.test.tsx`)
- failed startup degrades honestly: both the desktop-session startup catch path and the
  browser unrecoverable cold-bootstrap path now route through the persistent error toast
  instead of silently clearing the skeleton into a false first-run empty state
  (`desktop-session.test.ts`)
- optimistic pause flip now drives the click intent, labels, and busy id (an "Unpause" label
  can never silently re-send `pause_run` in the accepted-but-no-snapshot window), and an
  accepted resume keeps the rail and title-bar Resume controls disabled until a newer run
  snapshot lands (`TaskCoordinatorSection.test.tsx`, `TaskTitleBar.test.tsx`)
- provisional pending-task panels are `transient` `ResizablePanel` children excluded from
  panel-size persistence, so `pending-task:<id>` keys can never leak into `store.panelSizes`
  (`ResizablePanel.test.tsx`)

New UX spec locks: `tests/browser/startup-skeleton.spec.ts` (no first-run copy during a real
cold reload, skeleton seen with the cached 2-column shape, no intermediate zero-column frame,
placeholder tail visible before `data-terminal-live-render-ready`) and
`tests/browser/terminal-preready-input.spec.ts` (marker typed from app-shell-visible reaches
backend scrollback exactly once) — both green on the rebuilt artifacts.

No regression in the program profiler numbers (same machine and method, 3 iterations, medians,
`artifacts/server-boot-profile/perceived-latency-verify-2026-06-11.json`):

- 2 tasks: boot-to-listen `1,679.7ms`, cold bootstrap during boot `91.2ms`, settled cold
  bootstrap `2.3ms`, gitSubprocessCount `2`
- 12 tasks: boot-to-listen `1,729.7ms`, cold bootstrap during boot `96.0ms` (target `< 600ms`),
  settled cold bootstrap `2.5ms`, gitSubprocessCount `12`; 12/2-task ratio `1.03`
  (target `<= 1.2x`); `focusSignalSupported: true`

Gates: typecheck clean; `npm run test:node:default` 3,007/3,007 (+7 skipped, the
`standalone-server.test.ts` suite-order flake recorded by review did not reproduce);
`npm run test:node:coordinator:e2e` 32/32; `npm run test:node:server-integration` 43/43 on an
idle machine; `tests/contracts` 41/41; `npm run test:solid` 77 files / 778 tests;
`npm run test:browser:terminal:shared` 26/26 (including the 1344/1469 visual-stability and 543
input-flush locks); `npm run test:browser:canaries` 7/7; eslint on all changed files with
`--max-warnings 0` clean.

Gated startup-metrics lane (`benchmark:browser:startup-metrics`, this machine): 1-terminal
prompt-ready queued-to-interactive `151.2ms` (budget 250ms, doc capture 137.9ms — unchanged);
reconnect-restore and startup-buffer captures green. The 8/24-terminal fleet budgets currently
FAIL on this machine (8-terminal ~`373-424ms` vs 350ms budget; 24-terminal ~`1,452-1,478ms` vs
800ms budget) — verified inherited, not an item-5 regression: the same lane at the pre-item-5
diff baseline (items 1-4 tree, measured in a throwaway worktree of the baseline snapshot with
identically built artifacts) fails in the same band (8-terminal `346.6/371.6/386.4ms`,
24-terminal `1,337.9/1,397.4/1,510.3ms`), while the attach-pipeline item's 2026-06-10 capture
recorded `204.3ms`/`587-671ms`. The breach therefore arrived with the delta-resync item (whose
verification ran canaries/remote but not this gated lane) or environmental drift since
2026-06-10, and needs a follow-up attribution pass on the items 1-3 trees before any budget or
code change.
