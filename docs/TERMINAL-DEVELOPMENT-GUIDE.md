# Terminal Development Guide

This is the contributor guide for terminal, browser-control, browser-lab, restore, and
terminal-performance work in Parallel Code.

Read this after [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md),
[ARCHITECTURE.md](./ARCHITECTURE.md), [TERMINAL-CONTRACT.md](./TERMINAL-CONTRACT.md), and
[TESTING.md](./TESTING.md).

Use this guide when you are:

- changing PTY lifecycle or output batching
- changing browser terminal input/output/recovery behavior
- changing takeover, task-command control, or resize authority
- adding or debugging browser-lab coverage
- debugging large-history TUI switching, reload, or reconnect issues

It focuses on the parts that are hard to infer quickly from code alone.

This document owns:

- terminal and browser-lab operational workflow
- terminal-specific validation recipes
- profiling and diagnostics runbooks
- non-obvious contributor knowledge for terminal, recovery, and control work

This document does not own:

- repo-wide validation policy
- architecture ownership rules
- generic review heuristics

Artifact directories under `artifacts/` are local browser-lab output, not source-of-truth inputs.
Put durable lessons in this guide or in
[TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md). Do not treat local artifact paths
as part of the default validation contract.

## Quick Start

If you touch browser terminal runtime, browser harness, or terminal restore behavior:

1. run the scripted browser terminal matrix:
   - `npm run test:browser:terminal`
     This script runs the `large-history background tab switches` case first in its own Playwright
     invocation, then runs the shared deterministic Chromium lane. That keeps the background-switch
     contract in the default gate without inheriting contamination from the heavier render/restore
     cases that follow.
   - `npm run test:browser:terminal:soak` for the isolated long-additive acceptance soak
2. run the backend/runtime seams:
   - `npx vitest run --config vitest.config.ts --no-file-parallelism server/terminal-latency.test.ts server/session-stress.test.ts electron/ipc/pty.test.ts electron/ipc/handlers.restore.test.ts src/lib/scrollbackRestore.test.ts src/app/task-command-lease.test.ts`
   - `npm run test:node:terminal:stress` when selected/passive terminal roles, multi-agent task
     layout, or non-browser terminal stress profiles change
3. if the issue is about latency or noisy background contention, run the scripted local profiler:
   - `npm run profile:terminal:latency`
   - when turning profiler findings into browser assertions, warm terminal input tracing once and
     reset diagnostics before measuring so clock-sync startup does not pollute the latency budget
   - when warming tracing on a shell prompt, clear the prompt line after the warmup before the
     measured action; otherwise the harness measures redraw on a dirty command line instead of the
     real latency path
   - keep exact burst-window assertions in unit/runtime seams; browser multi-char typing tests
     should prove user-visible responsiveness instead of assuming one accepted batch renders as one
     atomic visible chunk
4. if the issue is about many active terminals or steady-state renderer pressure, run specialized
   steady-state benchmarks before leaning on browser repros:
   - `npm run benchmark:terminal:renderer`
   - `npm run benchmark:terminal:attach-recovery`
     - scheduler scenarios: `foreground-serialized`, `background-two-slot`,
       `reprioritized-pending` (background fleet plus a pending promoted-foreground candidate; the
       asserted bar is `maxActive >= 2`, no serial collapse), and `dispatch-release` (slots
       released at attach dispatch; the asserted bar is a sub-60ms 24-terminal queue span)
   - `npm run benchmark:terminal:steady-state -- --iterations 12`
   - server-side attach/recovery counters live in the backend runtime diagnostics snapshot:
     `terminalRecovery` (per-kind responses including `tailNeededResponses`, returned bytes) and
     `terminalStateMirror` (enqueue/serialize/drain). Initial attach transfers its backend pause to
     a renderer-local output barrier immediately; other held recovery batch pauses auto-resume
     after 5s. A stuck-paused terminal therefore points first at a lost
     `ReleaseTerminalRecoveryPause`, then at a broken auto-resume timer
5. if the issue is about perceived browser fluidity under real many-terminal load, run the
   browser UI-fluidity gate after the specialized harnesses:
   - `npm run profile:terminal:ui-fluidity:gate`
   - `npm run profile:terminal:ui-fluidity:dense-gate`
6. if the issue still needs profiler evidence after the gate, use the exploratory browser
   UI-fluidity tools:
   - `npm run profile:terminal:ui-fluidity -- --surface agents --terminals 6`
   - `npm run profile:terminal:ui-fluidity:matrix:gate` (alias of the main gate)
   - `npm run lab:terminal:ui-fluidity:matrix -- --surface agents`
   - `npm run lab:terminal:ui-fluidity:experiments`
   - `npm run lab:terminal:ui-fluidity:trace`
   - if the matrix or wrapper already built the browser artifacts, let the child profiler runs
     reuse that prevalidated state instead of repeating the build-artifact check for every suite
7. finish with the remaining broad checks:
   - `npm run check -- --pretty false`
   - `npm test`

Treat steps `3` to `6` as performance-lab escalation, not as the default review gate for every
terminal change. The normal product-review minimum is:

- targeted tests at the owner seam you changed
- `npm run test:node:terminal:stress` when multi-agent task terminal layout or selected/passive
  command targeting changed
- `npm run test:browser:terminal` when browser terminal behavior changed
- the specific browser stress/spec gate that matches the regression class under review

For terminal task-control/takeover UI, keep detailed banner/chip state proof at the local owner seam
(`task-control-visual-state`) and use `TerminalView` only for thin integration coverage. Do not
rely on a large terminal integration suite as the only proof of task-control banner behavior.

Only escalate into profiler or benchmark scripts when the change is explicitly about performance,
fluidity, or many-terminal scaling.

If Playwright Chromium is missing:

- `npx playwright install chromium`

## Automated Local Repro

Prefer repo entrypoints that launch a fresh standalone server for you:

- `npm run test:browser:terminal`
- `npm run test:browser:terminal:soak`
- `npm run test:browser:file -- tests/browser/<spec>.ts --project chromium --workers=1`
- `npm run profile:terminal:latency`
- `npm run profile:terminal:ui-fluidity:gate`
- `npm run profile:terminal:ui-fluidity:dense-gate`
- `npm run profile:terminal:ui-fluidity -- --surface agents --terminals 6`

Do not make a hand-managed `npm run server` process your primary validation path. The scripted
paths avoid the stale-server problem that is easy to miss during browser terminal debugging.

For manual browser-mode development, run `npm run browser:dev`. The checked-in `.env.example`
values are loaded as local defaults, so the development URL is stable across restarts:
`http://127.0.0.1:43117?token=parallel-code-local-browser`. Copy `.env.example` to `.env` only when
customizing local values, and change `AUTH_TOKEN` before exposing the server outside local
development. Browser watch mode writes to `dist-browser-dev/` and `dist-remote-dev/`; it does not
mutate the production/test `dist/` artifacts that browser-lab validation serves. The watch-mode
server intentionally bypasses the production build-artifact freshness guard, because that guard is
for built `dist/` outputs and can race the live dev rebuilds.

Use a disposable, run-unique `PARALLEL_CODE_USER_DATA_DIR` when manually testing backend restart.
For the clean lane, stop the exact owned server normally, wait for its process tree to disappear,
then restart against the same directory and verify each managed agent or primary task shell is
restored once at the next generation. For the crash lane, kill that disposable server abruptly
(`SIGKILL` / `kill -9` on POSIX), restart against the same directory, and verify the missing session
shows recovery-required UI without a new process or output-channel bind. Never run the abrupt lane
against a shared development state directory, and do not delete the directory between the two
halves of either test—the durable shutdown evidence is what distinguishes them.

Browser Playwright entrypoints auto-prepare browser artifacts once when they are stale or missing,
reject zero-byte artifacts, and snapshot validated static assets into the per-test server directory
before launch. The standalone harness still fails on stale `dist`, `dist-remote`, or `dist-server`
if someone bypasses the wrapper, so stale browser runs do not silently succeed. Session-stress and
server integration setup use the same clean production server builder; do not invoke the broad
test-aware server tsconfig as a non-watch emit into `dist-server`. Browser-lab, browser/server test
helpers, and local terminal profilers also sandbox shell-terminal
home/history state, so interactive shell fixtures do not append typed test commands into the
contributor's real shell history. The sandbox is opt-in at the server-process boundary, applies
only to launches marked as shells, and redirects `HOME`/`USERPROFILE`, XDG data/config/state,
and Windows application-data locations into the cleanup-owned test directory while disabling or
redirecting shell/tool history files. Zsh, Bash/POSIX, Fish, and PowerShell receive shell-specific
startup protection; non-shell agent launches keep their normal environment.
`electron/ipc/test-shell-sandbox.ts` owns that shell classification and startup policy;
`electron/ipc/pty.ts` only decides whether the test-only policy is eligible for a launch. Raw Node
profilers and the session-stress runner share readiness and bounded shutdown through
`scripts/lib/standalone-server-process.mjs`; process-backed fixture tests reuse the same bounded
shutdown owner and its owned process-group/tree spawn. The typed browser-lab harness keeps its richer
overall lifecycle snapshot, but delegates readiness observation, process-tree spawn, and TERM/KILL
teardown to that same owner. The server integration helpers use it for both their primary and
simulated-latency servers. POSIX launches receive a dedicated root process group, while shutdown snapshots stable
PID/start-time identities and follows descendants that created their own group or session. The owner
captures that tree during startup output and again at readiness, so verified detached identities
remain available when the root exits before the first stop attempt. Those owned identities survive
the single bounded stop retry, receive TERM/KILL escalation, and must be absent from a final snapshot
before shutdown resolves. Windows shutdown invokes and awaits its tree request even when the root
already exited, then uses one bounded forced-tree escalation instead of treating root exit as proof
that descendants are gone. Profilers with disposable standalone-server
data also use the owner's development-state cleanup, while the boot profiler retains its broader
seeded fixture across iterations and removes that fixture as one unit. Temporary roots enter their
cleanup scope as soon as they are created, so repository seeding, state writes, spawn, readiness
failures, and uncooperative descendants cannot strand partial fixtures.

Generated profiler and stress outputs under `artifacts/` are local scratch data, not product
surface. Keep them out of review. Move durable conclusions into docs instead of relying on a
checked-in artifact path.

`npm test` is not the browser-terminal full gate by itself. It covers node + Solid suites only, so
the scripted browser terminal matrix above is part of the gate.

For steady-state scaling work, do not start with repeated browser manual repro loops. Use the
specialized scheduler/output-pipeline/output-analysis benchmarks to narrow the hot owner first,
then confirm the winning hypothesis in the browser.

For typing responsiveness work, keep one ownership rule in mind:

- `src/app/terminal-interactivity-governor.ts` owns when a terminal is typing-critical
- input, output scheduling, and fit/session layers are consumers of that state
- do not add new focused-input or visible-sibling heuristics in those downstream layers unless the
  governor contract itself is insufficient

For terminal media and shortcut work, keep two more ownership rules in mind:

- Electron clipboard-image access belongs behind typed IPC; terminal-session may request a temp-file
  path, but it must not read native clipboard images directly
- terminal key ergonomics belong in `src/lib/terminal-shortcuts.ts`; terminal-session should
  consume that policy for both keydown sends and non-keydown suppression instead of open-coding key
  combinations in the view owner

For deployed latency debugging, verify the build before trusting numbers:

- fetch `/build-metadata.json` with the browser auth bearer token and confirm `buildCommit`
  matches the commit under review
- `npm run profile:terminal:latency -- --server-url <url> --auth-token <token>` prints build
  metadata, API RTT, visual echo timing, and backend trace timing when trace completion is healthy
- open `<url>/latency?token=<token>&autorun=1` from the client machine to measure same-origin HTTP
  ping, HTTP IPC, and websocket ping/pong latency without a local checkout
- visual echo timing is the fallback for TUI-heavy agents and stale/contaminated sessions where
  backend echo traces may stay active because the terminal is emitting control responses instead of
  plain shell echo
- pass `--skip-trace` when you only want deployed visual echo and API RTT, or
  `--keep-profile-terminal` when you need to inspect the profiler shell after the script exits

The intended steady-state contract is:

- the typing-critical terminal gets latency priority
- visible non-focused siblings make bounded progress
- hidden siblings keep background progress without competing for latency
- fit/layout owners may defer non-critical stabilization, but resize/correctness-critical work must
  still run

When browser responsiveness lanes fail after this kind of change, isolate the failing lane once
before retuning. Recent debugging showed that fresh-artifact isolated reruns can separate real
policy regressions from combined-suite variance after rebuild-heavy terminal runs.

For many-terminal browser profiling, prefer the `agents` surface first. It exercises the real
task-panel terminal path, priority lanes, and active-agent analysis path without relying on manual
Hydra repros.

When a hidden-terminal change is under review, split render wake and session wake into separate
profiling cases so a win in one mode does not hide a regression in the other. If the workload may
depend on how many terminals are actually visible, sweep a narrower visible-shape profile instead
of only using one full-width browser viewport.

The browser UI-fluidity profiler is meant to answer a different question than session stress:

- session stress tells you whether backend and transport pressure are the bottleneck
- UI-fluidity profiling tells you whether the browser main thread is missing frames, building long
  tasks, or starving focused/visible terminal work while background terminals stay active

The browser profiler output is most useful when you read these signals together:

- frame-gap and long-task totals for visible UI smoothness
- focused round-trip timing for interactive responsiveness
- cumulative terminal write bytes/calls plus per-frame write pressure
- focused/visible/hidden queue-age totals
- terminal render latency from the write callback path

When a terminal looks visually wrong but not obviously broken, prefer the generic anomaly surface
before chasing an agent-specific repro. The browser-lab diagnostics now expose a terminal anomaly
snapshot alongside the existing renderer/output counters, so contributors can distinguish real
steady-state recovery or redraw churn from harmless control-heavy TUI traffic.

For a retained WebGL surface whose glyph atlas looks blank or corrupt while terminal bytes remain
intact, use the remappable `Redraw terminals (fix rendering glitches)` action (default
Cmd/Ctrl+Shift+L). This is a paint-only pool operation: a successful repair must not increase
recovery, renderer acquisition/eviction, resize, or PTY-input counters. Validate changes with the
pool state-machine suite and `tests/browser/terminal-webgl-repaint.spec.ts`; a browser lane without
WebGL must report that limitation explicitly and prove the DOM no-context branch instead of passing
the repair assertion silently.

For real optimization work, do not stop at one baseline browser profile.

Use this sequence:

1. prove the likely owner with the specialized runtime benchmarks
2. run the repeated UI-fluidity variant matrix at the target terminal count
   - keep one explicit `baseline` variant that disables the product-default focused preemption
     policy
   - compare that against the current product policy and any experimental candidates
3. shortlist only the variants that improve browser fluidity without hurting focused interaction or
   hidden-to-visible task switches
4. capture browser traces only for that shortlist

That keeps the browser step evidence-driven instead of turning it into an unbounded manual tuning
loop.

When hidden-terminal cost is the suspected lever, add a dedicated hidden-switch workload instead of
looking only at steady-state summaries. A hidden-terminal policy is not a win if it improves
background backlog but makes task selection or wake restore feel slower.

For render-hibernation or session-dormancy experiments, keep the wake suites isolated from generic
hidden-switch or long mixed-workload runs. Those suites prove specific lifecycle stages, so they
should measure a fresh terminal state instead of whatever lifecycle phase happens to be left after a
longer combined profile.

When a hidden-switch suite is the main question, treat the switch probe itself as the round-trip
signal. Do not trust a generic focused-round-trip headline if the suite never reached a real
post-switch echo.

For hidden-switch profiling, split the handoff metrics explicitly:

- switch to first useful paint
- switch to input-ready

Do not collapse those into one `ready` number. Recent hidden-task switching and cold hidden wake
can share the same final ready state while still feeling very different during the handoff.

For app-owned switch-window timing, only mark first-paint or input-ready once the selected
terminal is actually visible. Input-ready should imply first-paint in the same lifecycle proof; do
not allow a switch-window state where input-ready is recorded while first-paint is still missing.

If the optimization is supposed to help a recently active hidden task, use a dedicated recent
hidden-switch suite instead of a generic cold-hidden target. A recent-switch policy is not proven
if the profiler only exercised a fully cold hidden terminal.

If you are testing sidebar-intent or hover-driven prewarm, keep those runs targeted to the hidden
switch suites. A broad mixed matrix can hide whether the prewarm helped the switch or just moved
work into another visible workload.

For bulk visible output work, do not treat one static write-batch cap as a generally safe answer
until it survives the visibility-shape sweep. A cap that looks good with one visible terminal can
still regress four-visible or dense-grid cases badly enough to disqualify it as a product default.

Do not promote a visible-render pacing candidate on the core browser profiles alone. A candidate
that improves `recent_hidden_switch`, `interactive_verbose`, or `bulk_text` can still regress
structured visible workloads badly enough to fail the product bar. Before treating a visible-render
policy as product-ready, rerun it against at least one prose-heavy, diff-heavy, and agent-style
structured burst profile across the same one-visible and few-visible layout sweep.

Do not skip the intermediate few-visible sweep. Recent browser runs showed that `2 visible`
terminals can regress differently from both `1 visible` and `4 visible`, so a candidate is not
proven by sparse-only and dense-only runs.

When a browser perf run fails to produce a hidden-switch timing, keep that measurement as `n/a`
through the aggregate summary. Do not coerce missing first-paint or input-ready timings to `0ms`,
because that can make a failed handoff look like the healthiest run in the report.

Before promoting a lane-specific terminal scheduling candidate, verify that the browser matrix
actually exercises that lane. Recent pressure-yield experiments showed `active-visible-bytes p95=0`
across the many-terminal browser gate, which means those runs are dominated by `focused` and
`visible-background` work and cannot prove an `active-visible` policy either way.

When you need to prove `active-visible` behavior specifically, use a dedicated selected-task browser
suite instead of the generic gate. The current targeted suite is `active_visible_selected` in the
UI-fluidity profiler: it keeps the selected task visible, moves focus into the task prompt so the
terminal stops being `focused`, and then waits for nonzero `active-visible` bytes before the
measured window starts. Keep focused round-trip timings as `n/a` for that suite; coercing them to
`0ms` or a timeout would misrepresent what the profile is trying to prove.

Treat `active_visible_selected` as supporting proof only. A candidate still has to clear the main
UX gate on `recent_hidden_switch`, `interactive_verbose`, and `bulk_text` across `1`, `2`, and
`4 visible` layouts before it is product-safe.

Keep the packaged defaults aligned with that gate. The explicit npm gate entrypoints should make
their scope obvious:

- `profile:terminal:ui-fluidity:gate` is the canonical `1,2,4 visible` sweep against
  `product_default` and `high_load_mode_product`; its matrix artifacts include provisional budget
  observations, and `--fail-on-budget` is reserved for branches explicitly trying to satisfy this
  loaded browser lane
- `profile:terminal:ui-fluidity:matrix:gate` is a compatibility alias for that same gate, not a
  second independently maintained command
- `profile:terminal:ui-fluidity:dense-gate` is the direct `4 visible` dense comparison against the
  same variants
- exploratory commands must stay explicitly labeled as exploratory in docs, review notes, and npm
  scripts

Keep the contributor guide focused on current truth, not the full experiment ledger:

- `product_default` remains the fallback baseline for sparse and explicit-off behavior
- `high_load_mode_product` is the current dense heavy-load comparison path, not a proof that every
  heavier surface-lifecycle experiment is product-safe
- shipped scheduler policy is the built-in High Load Mode profile plus the exact-count `2 visible`
  and `4 visible` tables it carries. Treat `denseOverload*`, per-priority drain-budget/candidate
  overrides, and similar injected tuning families as lab surface until they earn product status
- role-based passive mirror substitution, structural live-surface caps, and other experiment
  families remain deferred until they beat the shipped gate on clean reruns
- multi-terminal visible layouts should default extra visible siblings into `passive-visible`; do
  not invent extra visible surface roles for ordinary siblings. Keep visible panels on the real
  xterm surface and let scheduler/pacing policy, not synthetic overlays, absorb the load
- for dense promotion work, run the direct dense gate first, then rerun at least one `1 visible`
  and one `2 visible` sanity check before changing the product story
- when a change touches browser-side terminal recovery, output, fit, or render code, rebuild
  browser artifacts before treating a profiler or browser-gate result as authoritative
- when the hidden-switch suite can age a prepared target into another lifecycle tier, treat an
  aged-out or missing switch measurement as evidence that the lifecycle model still needs work
- suppressed output during render hibernation must still count toward renderer-side pause/resume
  thresholds; hidden-terminal optimizations are not allowed to bypass backpressure

The historical experiment families, phase names, and local artifact paths now live in
[TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md). Keep that document as the archival
ledger for deferred candidates and measured dead ends; keep this guide limited to shipped behavior,
required gates, and contributor workflow.

## Owner Map

Treat terminal work as `reimplement on our architecture`.

Primary local owners:

- backend
  - `electron/ipc/pty.ts`
  - `electron/ipc/agent-handlers.ts`
  - `electron/ipc/task-command-leases.ts`
  - `electron/ipc/runtime-diagnostics.ts`
- handler / transport
  - `server/browser-channels.ts`
  - `server/browser-websocket.ts`
  - `src/lib/ipc.ts`
  - `src/lib/browser-http-ipc.ts`
- workflow / app
  - `src/app/task-command-lease.ts`
  - `src/app/task-workflows.ts`
  - `src/app/terminal-output-scheduler.ts`
  - `src/app/terminal-attach-scheduler.ts`
- presentation
  - `src/components/terminal-view/terminal-session.ts`
  - `src/components/TerminalView.tsx`
- browser-lab harness
  - `tests/browser/harness/fixtures.ts`
  - `tests/browser/harness/scenarios.ts`
  - `tests/browser/harness/standalone-server.ts`

Do not move backend recovery or control truth into renderer heuristics.

## Non-Trivial Truths

### 1. The browser lab runs against built artifacts, not live source

Playwright browser-lab coverage runs against `dist`, `dist-remote`, and `dist-server`.

Practical consequence:

- after changing browser terminal/runtime code, browser-lab results are only meaningful if you rebuilt
- the standard rebuild entrypoint is `npm run prepare:browser-artifacts`
- `tests/browser/harness/standalone-server.ts` now enforces freshness and snapshots static assets, but you should still think this way while debugging

### 2. `ready` is stricter than “textarea exists”

For browser terminals, `ready` should mean:

- xterm fit is ready
- restore is complete
- restore pause has resumed
- queued resize work can drain
- queued input can drain

Restore pauses are transaction-scoped in browser mode. A renderer restore sends a non-empty
`restoreLeaseId` with its `PauseAgent` / `ResumeAgent` pair and renews that same lease while a slow
restore is still fetching or replaying state. The PTY owner ignores stale resume ids, so an old
restore cannot unpause output for a newer restore on the same browser channel. Channel cleanup still
clears all scoped restore leases for that channel.

That is why browser-lab tests should prefer the harness readiness helpers instead of ad hoc DOM checks.
When a browser-lab render test also needs diagnostics or lifecycle capture, prefer the shared
`openSession(...)` harness path so teardown and artifact capture stay unified instead of
hand-rolling a separate browser context.

### 2a. Terminal status attributes have specific meanings

`data-terminal-status` is part of the terminal lifecycle contract.

Treat the values this way:

- `binding`
  - session exists, but backend channel bind or session wiring is not complete
- `attaching`
  - initial xterm attach / fit / first-mount readiness is still in progress
- `restoring`
  - a blocking recovery path is running; this should be rare and should normally mean snapshot
    fallback, not ordinary delta catch-up
- `ready`
  - fit, restore gating, and post-restore input/resize draining are complete enough for real
    interaction
- `error`
  - the terminal session failed and is not interactable

Important rule:

- `delta` and `noop` recovery should not surface `restoring`
- if a churn or reload scenario shows `restoring` unexpectedly, treat that as a recovery-policy
  bug, not just a UI detail

### 2b. Terminal presentation mode is the visible truth contract

`data-terminal-presentation-mode` describes what the user is actually looking at:

- `live`
  - current xterm surface
  - stdin may be enabled
- `loading`
  - startup/attach mask is covering the live surface
- `error`
  - the terminal failed

Important rule:

- visible unfocused terminals should stay on the real xterm surface even when their scheduler tier
  is `passive-visible`; do not replace ordinary visible panels with synthetic passive placeholder UI
- if the presentation mode is `loading`, the xterm surface should be masked and stdin should stay
  disabled

### 3. The hidden xterm helper textarea is not a reliable click target

The textarea can be attached while partially offscreen or not practically clickable.

Use:

- `browserLab.waitForTerminalReady(...)`
- `browserLab.focusTerminal(...)`
- direct `.focus()` when a test specifically needs “type during restore”

After a hidden-tab round trip, `browserLab.focusTerminal(...)` should reacquire focus through the
terminal root click path before typing. Do not shortcut on stale `document.activeElement` or
`document.hasFocus()` state after `page.bringToFront()`.

Avoid brittle raw click steps unless the click itself is what you are testing.

### 3a. Terminal readiness must not own startup focus policy

Browser terminals can finish attaching at different times during restore or page load. If each
terminal decides to call `term.focus()` when it becomes ready, background shells can steal focus
from the terminal the user already chose.

Practical consequence:

- terminal/session code may expose a focus callback, but it should not auto-focus itself as a
  startup policy
- late focus replay should flow through `src/store/focus.ts`, which can confirm the panel is still
  the current focused target before applying it
- browser-lab reload regressions should type into one shell while later shells are still becoming
  ready
- cold browser bootstrap should only unblock background terminal attach after the selected terminal
  gets a head start or the documented startup fallback fires; terminal owners must not silently
  reopen that policy from leaf readiness callbacks

### 3b. Terminal session teardown is identity-sensitive

`TerminalView` can remount for a new agent session while old async callbacks, timers, readiness
callbacks, or Solid cleanups are still unwinding.

Practical consequence:

- snapshot the session identity and spawn props at the mount/remount boundary
- clear registered focus callbacks only when the disposing callback still matches the current
  callback for that agent
- guard unmounting views before toggling input-feedback or readiness state from late callbacks
- task-level terminal sections should key remounts by agent id plus terminal session version, not
  by mutable task props alone
- do not let a late cleanup from a passive sibling cancel the task-level switch window or steal
  focus from the currently selected terminal

### 4. Large-history TUI switching bugs are usually recovery-policy bugs

If a large-history TUI:

- blanks
- flashes
- refills the same history again
- becomes slow when switching away and back

the problem is usually not a simple panel remount. The common causes are:

- channel continuity loss
- recovery fallback taking the snapshot/reset lane too often
- browser terminal reporting `ready` too early
- background terminal work consuming too much scheduler/render budget

### 5. Plain rebind and structured recovery are different paths

Plain channel rebind should resume live output and backlog delivery.
Historical recovery should go through the structured terminal recovery contract.

Do not reintroduce “history replay through live `Data`” on rebind.

### 6. Shell layout persistence matters for browser reload coverage

Browser shell panels are part of workspace/session persistence behavior.

Practical consequence:

- creating or closing a shell terminal in browser mode must persist layout state promptly
- otherwise reload/restore tests can fail because the shell surface itself disappears, which looks like a terminal bug but is actually a persistence bug

### 7. The stress harness must stay aligned with the real lease contract

The task-command lease path now requires `ownerId`, not only `clientId`.
Browser desktop acquire / renew / release requests use the websocket control plane when possible,
and pagehide release falls back to keepalive HTTP with the browser client-id header because
`sendBeacon` cannot attach that identity header. The server must derive lease identity from the
authenticated transport or browser client header, never from JSON supplied by the page.

Practical consequence:

- stress and churn helpers must use the current lease contract or they silently stop exercising the real control model
- browser, remote, and pagehide lease tests must prove the same authenticated client identity path
- full `npm test` is important here because targeted terminal tests may miss harness drift

### 8. Reset diagnostics before profiling or churn debugging

The profiler and recovery diagnostics are only useful if they describe the scenario you just ran.

Reset first, then compare:

- backend recovery counters
- browser trace timings
- terminal status history

## Recovery Model To Preserve

Browser terminal recovery is backend-owned and explicit.

Current model:

1. live output arrives over the channel stream
2. continuity loss is signaled as `RecoveryRequired`
3. visible non-shell startup attach requests `GetTerminalStartupRecoveryBatch`
4. visible shell startup/reload attach stays on the ordinary `GetTerminalRecoveryBatch` path, but
   local rendered-tail replay is suppressed so shell continuity does not fall back to renderer-side
   request-state overlap
5. reconnect and non-startup recovery use `GetTerminalRecoveryBatch`
6. hidden shell reload attach is gated on reveal/prewarm; when it starts, it remains on the
   ordinary attach/recovery path
7. the backend returns one of:
   - `noop`
   - `delta`
   - `terminal-state`
   - `snapshot`

Current batching rule:

- visible non-shell startup uses the dedicated startup batch path so the backend, not the renderer,
  owns serialized terminal-state recovery for `selected` and `visible-sibling` terminals
- visible shell attach intentionally does not inherit that snapshot-first policy; it stays on the
  ordinary attach path with rendered-tail suppression so reload/background-switch shell cases stay
  stable without forcing startup snapshot replay
- reconnect and non-startup recovery still use the shared batched `GetTerminalRecoveryBatch` path
- hidden attach still uses the ordinary attach/recovery contract
- batching only coalesces recovery lookups; each terminal still keeps its own outer
  pause/apply/resume lifecycle so live output cannot race the applied state
- recovery responses carry backend `cols` and `rows`; attach recovery must either align the local
  xterm to that geometry before replay or reject the entry

Important request state:

- `outputCursor`
- retained rendered tail
- shell reload continuity may reuse the current tail, but it must not promote that tail into
  startup snapshot policy

Recovery preference:

1. visible non-shell startup prefers backend-owned serialized `terminal-state` recovery
2. visible shell attach stays on ordinary attach with rendered-tail suppression; it does not use
   the startup terminal-state policy
3. reconnect and non-startup recovery prefer cursor-based `delta` when the requested cursor is
   still in the retained backend window
4. reconnect and non-startup recovery then try rendered-tail overlap `delta`
5. reconnect and non-startup recovery fall back to `snapshot` only when delta cannot be proven
6. visible non-shell startup falls back to compact `snapshot` only when the backend terminal-state
   mirror is unavailable, and that fallback must be counted in backend diagnostics

Important UI rule:

- only full-state recovery (`terminal-state` or `snapshot`) may surface blocking `restoring` UI or
  call `term.reset()`
- `delta` and `noop` recovery should stay non-blocking
- while `Connecting`, `Attaching`, or blocking `Restoring` UI is visible, the live xterm surface
  should stay masked so users do not see historical snapshot replay scroll underneath the overlay
- maintenance-critical proof for the shell attach policy lives in the large-history browser cases in
  `tests/browser/terminal-restore.spec.ts`: reload attach, panel-resize-overlap, background tab
  switches, and width-sensitive reload attach

Important anti-patterns:

- do not use `GetAgentScrollback` or `GetScrollbackBatch` for terminal attach/restore
- do not treat `RecoveryRequired` as permission to replay historical output through the live channel
- do not “fix” flicker by hiding the terminal while still taking the destructive recovery path unnecessarily

## When Touching Recovery

Treat terminal recovery changes as workflow and validation work, not only renderer polish.

Review and debugging guidance:

- if a churn, reload, or background-switch scenario unexpectedly shows `restoring`, treat that as a
  recovery-policy bug unless the path truly required snapshot fallback
- do not accept a renderer-only fix that hides flicker while the runtime still resets and replays
  history through the destructive recovery lane
- add at least one regression that exercises interaction during recovery, not only after the
  terminal is visibly ready
- prefer the scripted browser terminal entrypoints over a hand-managed standalone server when
  validating recovery changes locally
- when debugging recovery drift, compare terminal status history and backend recovery counters
  before assuming xterm rendering is the root cause

## Browser-Lab Workflow

### Core harness files

- `tests/browser/harness/fixtures.ts`
- `tests/browser/harness/scenarios.ts`
- `tests/browser/harness/standalone-server.ts`

Manual benchmark files:

- `tests/browser/terminal-startup-experiment.spec.ts`
  - opt-in browser-lab benchmark for first-load terminal restore timing
  - reports attach queue wait, bind time, recovery fetch time, replay/apply time, and total
    completion so startup regressions can be attributed to the real phase
  - includes traced `firstQueuedToLastReadyMs`, which is the most reliable full-startup completion
    metric when some terminals finish before the shell chrome becomes visible
  - the practical default matrix is `default-1-shell`, `default-2-shells`, `compact-3-shells`,
    and `default-4-shells`; keep heavier `manual-*` cases opt-in so the benchmark measures startup
    architecture instead of self-saturating the browser before reload
  - keep it out of normal browser suites unless `RUN_TERMINAL_STARTUP_EXPERIMENT=1` is set

### Most useful helpers

- `openSession(...)`
- `waitForTerminalReady(...)`
- `focusTerminal(...)`
- `typeInTerminal(...)`
- `runInTerminal(...)`
- `createShellTerminal(...)`
- `waitForAgentScrollback(...)`
- `beginTerminalStatusHistory(...)`
- `readTerminalStatusHistory(...)`

### When to use status history

Use terminal status history when testing recovery semantics, not just end state.

Examples:

- prove delta/noop recovery never entered blocking `restoring`
- prove reload/restore only blocks on real snapshot fallback
- prove a terminal can accept input while recovery is completing
- prove panel-resize-overlap cases by forcing one resize after interactive readiness before
  asserting render resize counters

### Scenario choice

Use:

- `createInteractiveNodeScenario()`
  - direct typing and echo-path debugging
- `createPromptReadyScenario()`
  - browser mount, readiness, reload/restore, shell switching
- custom shell commands inside browser-lab tests
  - large-history and noisy background cases

### When a browser test fails unexpectedly

Check these first:

1. did you rebuild standalone artifacts?
2. is the failure really terminal lifecycle, or did the shell/task layout fail to persist?
3. are you waiting on `ready`, or only on the absence of one loading string?
4. did the test use a brittle click on the helper textarea when a focus-based step was enough?

## Diagnostics And Profiling Workflow

### Browser-side trace

Enable in devtools:

- `window.__TERMINAL_PERF__ = true`

Use:

- `src/lib/terminalLatency.ts`

This is the right seam when the question is:

- “is latency before send?”
- “is latency after send but before visible echo?”
- “does noisy background output increase render delay?”

### Renderer output-path diagnostics

Enable in devtools:

- `window.__TERMINAL_OUTPUT_DIAGNOSTICS__ = true`
- `window.__parallelCodeTerminalOutputDiagnostics.getSnapshot()`
- `window.__parallelCodeTerminalOutputDiagnostics.reset()`

Use:

- `src/lib/terminal-output-diagnostics.ts`
- `scripts/fixtures/tui-footer-redraw.mjs`

This is the right seam when the question is:

- “are redraw-heavy control sequences reaching xterm as tiny focused writes?”
- “is the focused terminal taking the direct-write path or the queued path?”
- “did a pacing change reduce write count without changing the output bytes?”

When you need one evidence bundle for a smoke report, use the composite terminal diagnostics
capture/export path instead of copying individual snapshots by hand. It collects the anomaly
snapshot, renderer runtime diagnostics, output diagnostics, and lifecycle state into one JSON
payload so the next investigation starts from evidence, not from a partial screenshot.
For live local repros, enable the shared browser capture surface first and then capture the
focused terminal from the console:

- `await window.__parallelCodeTerminalDiagnosticsCapture?.enable()`
- reproduce the issue
- `await window.__parallelCodeTerminalDiagnosticsCapture?.captureFocused()`

For redraw/flicker debugging, prefer the footer-redraw fixture or an equivalent minimal TUI before
blaming Hydra-specific behavior. The goal is to prove the renderer policy against a controlled
cursor-save/restore + clear-line workload, then confirm the same pattern on real agent output.
Remember that transport chunks do not align to ANSI control-sequence boundaries. If a redraw fix
or diagnostic only recognizes complete escape sequences inside a single chunk, it can miss the real
failure mode.
For startup/resize flicker work, the preferred deterministic fixture is now
`scripts/fixtures/tui-render-stress.mjs` together with
`tests/browser/terminal-render-stress.spec.ts`. That fixture covers:

- large initial scrollback attach (`startup-buffer`)
- redraw-heavy alternate-screen resize churn (`resize-flicker`)
- high-volume additive TUI output with in-place statusline churn (`additive-burst`)

Wrapped terminal Markdown paths have a separate narrow proof in
`tests/browser/terminal-links.spec.ts`. Keep parsing, lexical root filtering, Unicode/cell mapping,
and the 128-row/4,096-cell bounds in `src/lib/terminal-links.ts`; the session facade should only
register/dispose the provider, guard exact-session activation, and delegate to the shared viewer.

Terminal search has its own real-xterm behavior and performance proofs in
`tests/browser/terminal-search.spec.ts` and `tests/browser/terminal-search-performance.spec.ts`.
When profiling it, begin before the overlay opens and record network entries, addon/listener counts,
input-to-result samples, and cleanup after close. The unopened and empty-query paths must fetch no
search addon and create no search owner; the first nonempty query may fetch it once. Use the
committed 500 KiB/5,000-line fixture for scan latency and the 100-cycle churn fixture for disposal
rather than a production terminal whose output cannot be reproduced.

Use that synthetic harness to isolate renderer/recovery policy first, then confirm the result on
the matching real-shell and real-interactive browser acceptance cases in the same spec before you
call a continuity fix production-ready. Keep the longer additive-output soak in
`tests/browser/terminal-render-soak.spec.ts` and run it as its own Playwright invocation when you
need the heavier acceptance pass.
If resize flicker only shows up in alternate-screen TUIs, suspect fit-driven grid churn before
blaming generic output synchronization. The current runtime now lets resize dirty marks settle
briefly before fitting alternate-buffer terminals, so repeated drag-resize does not keep forcing
intermediate grid changes and backend resizes while the layout is still moving.
The input pipeline now also treats PTY resize commits as a transaction instead of a stream: resize
events keep coalescing until the short commit window settles, and alternate-buffer terminals use a
longer commit window than normal shells. That keeps xterm measurement responsive while preventing
every intermediate drag size from forcing a backend redraw.
Do not assume resize freeze/masking is only for alternate-screen TUIs. The live `test444` agent
repro showed stale-buffer repaint while resize commits were still pending behind a `restore-blocked`
transaction, even though the active terminal was not in alternate screen mode. The freeze contract
must follow ready visible terminals with pending live resize work, not only alternate-buffer
detection.
Apply the same rule to the blinking cursor. Focus alone is not enough to decide whether the cursor
may blink: if hibernation wake, restore, or deferred live resize means the surface is temporarily
not trustworthy, suppress cursor blink until that blocker clears and force one viewport refresh when
recovery settles so stale cursor layers do not survive noop/delta restores.
Do not let background or passive terminals participate in every viewport resize burst. Keep their
latest pending geometry, but only flush the PTY resize once the terminal is actually live again;
otherwise a large multi-terminal layout can amplify one user resize into hundreds of unnecessary
backend redraw requests and make the focused TUI flicker.
Apply the same ownership rule to managed fits. If `fitAddon.fit()` still runs for every attached
terminal during that burst, xterm can locally reflow stale pages even though PTY resize commits are
already coalesced correctly. Non-live terminals should keep their dirty fit geometry pending and
only flush it once the same live/eligible seam says they may commit resize again.

### Real browser profiler

Default entrypoint:

- `npm run profile:terminal:latency`

Raw script:

- `scripts/profile-terminal-input-latency.mjs`

Important behavior:

- it warms tracing before measuring
- it supports quiet and noisy-background scenarios
- it is useful for localhost diagnosis when the product “feels choppy” but backend queue metrics are small

### Backend runtime diagnostics

Use:

- `IPC.ResetBackendRuntimeDiagnostics`
- `IPC.GetBackendRuntimeDiagnostics`
- `electron/ipc/runtime-diagnostics.ts`

This is the right seam when the question is:

- “did recovery use noop, delta, or snapshot?”
- “was delta cursor-based or tail-based?”
- “did backpressure or recovery counters increase during switching?”
- “did a visible terminal hit snapshot/reset during resize or startup?”
- “did PTY resize commits coalesce or churn?”

For recovery debugging, reset diagnostics before the scenario you actually want to measure.

## Debugging Order

When a terminal/browser bug is still ambiguous, use this order:

1. run the scripted browser matrix or profiler first
2. decide whether the symptom is:
   - input latency
   - output/render contention
   - recovery/restore churn
   - control/takeover drift
3. reset backend diagnostics
4. enable browser tracing if latency or render timing is part of the question
5. capture terminal status history if restore/recovery is part of the question
6. run the smallest targeted browser and backend seams before touching broader suites

This order is deliberately boring. It is much faster than chasing symptoms from a stale server or
from already-contaminated diagnostics.

## Validation Recipes By Change Type

### 1. Interactive typing / latency changes

Run:

- `server/terminal-latency.test.ts`
- `tests/browser/terminal-input.spec.ts`
- `tests/browser/terminal-noisy-background.spec.ts`

Also use:

- `npm run profile:terminal:latency`

Notes:

- `tests/browser/terminal-input.spec.ts` owns the raw single-key echo budget on the browser/PTTY
  path plus the focused shell single-key guard
- `tests/browser/terminal-noisy-background.spec.ts` owns the focused-shell latency budget while a
  background terminal is actively redrawing

### 2. Recovery / rebind / large-history TUI changes

Run:

- `electron/ipc/pty.test.ts`
- `electron/ipc/handlers.restore.test.ts`
- `src/lib/scrollbackRestore.test.ts`
- `tests/browser/terminal-restore.spec.ts`

Specifically assert:

- no historical live replay on rebind
- snapshot fallback count stays at zero for expected delta/noop cases
- terminal-state fallback count stays at zero when startup mirror recovery is expected
- terminal status history does not include `restoring` for non-blocking recovery scenarios

### 3. Control / takeover / resize-authority changes

Run:

- `src/app/task-command-lease.test.ts`
- `server/browser-control-plane.test.ts`
- `server/session-stress.test.ts`
- `tests/browser/multiclient-control.spec.ts`

Do not stop at a targeted unit file here. The stress suite catches lifecycle drift that targeted tests can miss.

Known proof gap:

- different-width resize-authority has owner-local proof in `server/session-stress.test.ts` and
  `src/components/terminal-view/terminal-input-pipeline.test.ts`; add browser-lab coverage when
  real browser viewport geometry, focus, paint, or multi-context resize coordination is the risk
- attach-priority changes must keep owner-local scheduler-budget proof current; the baseline budget
  proof lives in `src/app/terminal-attach-scheduler.test.ts`

If you change either area, add coverage or equivalent new validation before calling the slice done.

### 4. Shared browser harness changes

Run:

- the targeted browser specs you changed
- `npm test`

Reason:

- shared harness drift often appears only when different browser/runtime suites run together or when a helper no longer matches the real backend contract

## Remote And Production Validation

Use these workflows when the question goes beyond "does it work on localhost?":

- does `/remote` bootstrap correctly on a deployed server?
- does public-path latency or buffering change terminal/control behavior?
- is the current branch ready for a production push?

### Deployed browser-server checks

Use these first when localhost is healthy but the deployed browser path still looks wrong:

- remote bootstrap smoke against the deployed server
- runtime diagnostics watcher against the deployed server
- a remote stress or matrix run against the deployed server when the issue looks like fanout,
  replay, or slow-link pressure instead of simple bootstrap breakage

Practical rule:

- compare localhost and deployed diagnostics before assuming the backend runtime is the problem
- if VM-local diagnostics stay quiet while the public path still times out or shows large skew, the
  remaining issue is usually proxy/network-path behavior rather than server-side saturation

### Visibility-shape experiment workflow

When a terminal perf candidate needs different behavior for `1`, `2`, and `4 visible` layouts:

- keep the existing `single / few / dense` density buckets stable so older variants remain
  comparable
- add exact visible-count overrides in the experiment seam instead of redefining what `few` or
  `dense` means globally
- compare a new shape-split candidate against both:
  - `product_default`
  - the current dense benchmark reference

Why:

- `product_default` is still the real shipping baseline for sparse interaction
- the current dense benchmark reference may still be the better comparison for `4 visible` switch
  and bulk behavior
- comparing against only one of those can hide either a sparse regression or a lost dense win

### Local input feedback

Local input feedback is enabled by default through the user/device setting in Settings > Behavior.
It gives the selected terminal immediate renderer-only acknowledgement while remote echo is still in
flight. The current product variant is an immediate frame pulse on locally admitted input:

```js
window.__PARALLEL_CODE_TERMINAL_EXPERIMENTS__ = {
  localInputFeedbackMode: 'ack-pulse',
  localInputFeedbackDurationMs: 180,
};
```

For deployed/manual tests, URL query params still override the persisted setting:

```text
?terminalLocalInputFeedback=ack-pulse&terminalLocalInputFeedbackDurationMs=180
?terminalLocalInputFeedback=off
```

This is not local echo. It must never call `term.write`, mutate xterm state, enter scrollback /
recovery history, draw inside the terminal buffer, or mount a visual layer above xterm. Feedback
starts when renderer input is locally admitted, then clears on the next authoritative output render
or timeout. The older
`inputAcknowledgementMode: 'pulse'` gate remains available for backend-accepted pulse comparisons,
but it intentionally starts later.

The provisional `text-overlay` variant was rejected after deployed TUI testing because the renderer
does not know the TUI app's semantic input cursor. Keep local feedback in terminal chrome, not
terminal content.

With renderer runtime diagnostics enabled, `terminalInput.localFeedbackAckPulses` counts local
feedback events in the diagnostics snapshot.

Use it to test perceived latency on TUI-heavy agents. Reject it if it creates duplicate glyphs,
cursor drift, masked-input leakage, terminal history divergence, or worse focused round-trip /
long-task metrics.

### Release and stress workflow

When shared-session transport, replay, or hot-session PTY behavior is part of a release decision:

- use the production matrix or production gate rather than one ad hoc stress run
- use the smoke matrix for fast confidence, not as the final production transport proof
- use the slow-link tuning matrix when changing browser-channel degraded-mode thresholds instead of
  comparing one lucky manual run

Keep `scripts/session-stress-profiles.mjs` as the source of truth for named profile and budget
definitions. The docs here should explain when to use a profile or matrix, not duplicate every
exact threshold.

### Reverse-proxy and deployment notes

When terminal/browser behavior changes only on the public route, keep the proxy policy explicit:

- keep websocket and request/response IPC paths distinct
- disable proxy buffering on the terminal/control paths
- use explicit long-lived timeouts for websocket and IPC proxying
- keep socket keepalive enabled on the proxied locations

This is the common failure shape behind "localhost works, deployed browser mode is choppy or times
out" bugs. Validate the public path directly instead of assuming localhost browser results cover it.

## Common Review And Debugging Mistakes

- trusting browser-lab results from stale build artifacts
- treating terminal readiness as “the textarea exists”
- adding renderer heuristics instead of fixing backend-owned recovery truth
- using `GetAgentScrollback` as an attach/restore shortcut
- forgetting that shell layout persistence can masquerade as a terminal restore bug
- fixing only the happy-path browser spec and skipping churn/stress coverage
- updating the backend control contract without updating the stress harness helpers
- treating request-tracked browser terminal input as successful once it reaches the websocket; the
  terminal hot path must wait for backend acceptance when the request carries a command `requestId`
- clearing queued terminal input on temporary lease/transport loss instead of retrying after the
  browser control plane recovers

## Definition Of Done For Terminal/Browser Changes

A terminal/browser slice is not done when one narrow repro stops reproducing.

It is done when:

- ownership is correct at the right layer
- non-destructive recovery paths stay non-destructive
- the deterministic terminal/browser full gate is green:
  - `npm run test:browser:terminal`
    This includes the isolated `large-history background tab switches` check first, before the
    shared deterministic Chromium lane.
  - targeted backend/runtime seams
  - `npm run check -- --pretty false`
  - `npm test`
- the isolated soak lane also passes when run on its own:
  - `npm run test:browser:terminal:soak`
- targeted node/runtime/browser seams are green
- the relevant stress or churn suites are green
- the docs in this directory describe the new behavior clearly enough for the next contributor

## What To Update With The Code

When terminal/browser behavior changes materially, update the owner:

- [ARCHITECTURE.md](./ARCHITECTURE.md) for current runtime behavior
- [TESTING.md](./TESTING.md) for reusable validation policy
- [REVIEW-RULES.md](./REVIEW-RULES.md) for reusable review lessons
- [TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md) for deliberate deferrals
- this file for workflow, harness, profiling, and debugging practice
