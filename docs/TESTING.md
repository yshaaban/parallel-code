# Testing Strategy

This document describes the current testing strategy for Parallel Code and the principles behind it.

It is intentionally architecture-focused. The goal is not just to grow the number of tests. The
goal is to make future changes safer, especially in the parts of the system that are hardest to
debug:

Read these first when deciding where behavior should live or how an upstream test should be adapted locally:

- [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md)
- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md)
- [REVIEW-RULES.md](./REVIEW-RULES.md)
- [TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md) for the practical browser-lab and terminal contribution workflow

This strategy is mainly about:

- reconnect and replay behavior
- startup and persistence
- multi-client presence, takeover, and control
- server-owned pushed state
- backend supervision and attention routing
- task-scoped preview routing and replay
- review readiness, overlap, and convergence queueing
- high-churn product screens
- browser-only terminal rendering, restore, and focus behavior

## Validation Layers

Parallel Code now uses four complementary validation layers:

1. node / backend contract tests for replay, transport, control, and recovery semantics
2. Solid product-behavior tests for the highest-churn desktop UI surfaces
3. a Playwright browser lab for real browser startup, terminal rendering, restore, and
   representative multi-client flows
4. headless stress and diagnostics harnesses for latency, volume, fanout, and replay pressure

The important rule is that higher-risk terminal and multi-client changes should carry more than one
seam. A terminal or browser-collaboration change that only has a small component test is usually
under-validated.

Validation seam mapping in repo terms:

- `node / backend`
  - vitest node suites, contract tests, backend recovery/transport/control tests
- `runtime / integration`
  - browser-lab Playwright specs and headless stress/diagnostics harnesses
- `Solid / UI`
  - `vitest.solid.config.ts`
- `docs / sanity only`
  - documentation-only changes with no runtime behavior impact

## Common Commands

- `npm test`
- `npm run test:node`
- `npm run test:solid`
- `npm run prepare:browser-artifacts`
- `npm run test:browser:e2e`
- `npm run test:browser:terminal`
- `npm run test:browser:remote`
- `npm run test:reliability`
- `npm run profile:terminal:latency`
- `npm run stress:session:prod-gate`
- `npm run diagnostics:watch -- --help`

## Testing Principles

The current test strategy should stay aligned with these rules:

1. Test architectural contracts, not temporary implementation details.
2. Prefer server-authoritative contracts for server-owned state.
3. Prefer race, replay, and recovery coverage over shallow collaborator-call tests.
4. Use node-side tests for transport, workflow, and lifecycle behavior.
5. Use Solid/jsdom tests for high-churn product behavior.
6. Use real browser automation when render, focus, restore, or multi-tab behavior is the risk.
7. Add tests that will still be valuable after refactors, not tests that only mirror current helper structure.

Architecture guardrails are also part of the suite now. We intentionally keep a small set of source-level architecture tests around:

- bootstrap registry completeness
- startup listener ownership
- review-surface freshness boundaries
- task-row presentation boundaries

These are meant to protect design constraints that are easy to violate accidentally and expensive to rediscover later.

## Test Suite Split

The test surface is intentionally split by runtime and by validation purpose.

### 1. Node Suite

Config:

- `vitest.config.ts`

Command:

- `npm run test:node`

What it covers:

- backend workflows
- IPC handlers
- websocket transport
- browser server behavior
- peer presence snapshots and takeover timeout policy
- supervision analysis and replay
- task-port detection, exposure, and browser preview proxying
- PTY and latency behavior
- reconnect, replay, and control-lease contracts
- startup/reconciliation logic that does not require a DOM

This suite is the main protection for correctness and reliability.

### 2. Solid Screen Suite

Config:

- `vitest.solid.config.ts`

Command:

- `npm run test:solid`

What it covers:

- `src/components/TaskPanel.tsx`
- `src/components/TerminalView.tsx`
- `src/components/Sidebar.tsx`
- `src/components/SidebarFooter.tsx`
- `src/components/ChangedFilesList.tsx`
- `src/components/ReviewPanel.tsx`
- `src/components/ConnectPhoneModal.tsx`
- `src/components/DisplayNameDialog.tsx`
- `src/components/SidebarTaskRow.tsx`
- `src/components/TaskTakeoverRequestDialog.tsx`
- `src/components/PreviewPanel.tsx`
- `src/components/TaskTitleBar.tsx`

This suite protects user-facing behavior in the highest-churn UI surfaces.

### 3. Browser E2E Lab

Entrypoint:

- `npm run test:browser:e2e`

Representative specs:

- `tests/browser/authenticated-load.spec.ts`
- `tests/browser/terminal-input.spec.ts`
- `tests/browser/terminal-fixtures.spec.ts`
- `tests/browser/remote-bootstrap.spec.ts`
- `tests/browser/remote-mobile-session.spec.ts`
- `tests/browser/terminal-noisy-background.spec.ts`
- `tests/browser/terminal-restore.spec.ts`
- `tests/browser/multiclient-control.spec.ts`

What it covers:

- authenticated browser bootstrap into the standalone shell
- tokenized remote bootstrap into the mobile remote shell
- direct keyboard typing and burst input through the real browser terminal input path
- first-run remote session naming and desktop presence visibility
- remote mobile submit flows that must clear focus so the viewport can reveal fresh output
- remote/mobile ownership flows where HTTP lease results and websocket controller events must stay
  immediately consistent
- mobile background/resume flows where presence heartbeats and takeover state must recover without a
  hard refresh
- first terminal mount and visible loading states
- deterministic TUI fixture execution in a real browser
- focused typing while a background terminal redraws heavily
- reload/restore with warm scrollback
- reload/restore where input arrives before the terminal has fully cleared recovery state
- large-history terminal recovery across background tab switches without destructive replay
- large-history background-switch churn with terminal status-history assertions so cursor/delta recovery does not surface a blocking restore phase
- large-history background tab switching without destructive recovery fallback
- representative multi-client read-only, takeover, ownership UI, and post-takeover typing flows

This layer exists because jsdom and node-only integration tests do not reliably catch terminal fit,
restore, focus, visibility, or real multi-tab browser behavior.

Non-obvious workflow rule:

- if you run the wrapper scripts above, they build browser artifacts for you through
  `npm run prepare:browser-artifacts`
- if you run raw `npx playwright test ...`, `node scripts/profile-terminal-input-latency.mjs ...`,
  or other standalone browser-lab entrypoints directly, run `npm run prepare:browser-artifacts`
  first or the harness will fail on stale `dist`, `dist-remote`, or `dist-server`

### 4. Stress And Diagnostics Harnesses

Primary entrypoints:

- `server/session-stress.test.ts`
- `scripts/session-stress.mjs`
- `scripts/session-stress-matrix.mjs`
- `scripts/runtime-diagnostics-watch.mjs`

What they cover:

- high fanout output delivery
- concurrent input and output pressure
- reconnect storms
- late-join replay
- slow-link and public-path validation
- transport diagnostics and bottleneck counters

These harnesses are part of the required validation story for terminal and browser transport work.
They are not just optional performance experiments.

## What The Current Tests Are Meant To Prove

### Reliability And Recovery

The node suite should continue to prove that:

- reconnect receives the latest replayable state
- stale events do not mutate current live state
- control leases stay exclusive and release correctly
- backpressure and flow control do not corrupt other clients
- interactive terminal input stays within the current localhost RTT budget
- startup and cleanup ordering remain safe
- supervision snapshots replay correctly after reconnect
- prompt / question / quiet-state detection produces stable attention states
- task-port snapshots replay correctly after reconnect
- browser preview proxying stays auth-gated and task-scoped
- startup/bootstrap registry behavior and architecture guardrails around runtime state ownership

Representative files:

- `tests/contracts/*.test.ts`
- `server/terminal-latency.test.ts`
- `src/lib/ipc.test.ts`
- `src/lib/websocket-client.test.ts`
- `src/runtime/server-sync.test.ts`
- `src/runtime/browser-session.test.ts`

### Terminal Latency And Perf Probes

The terminal path now has two different measurement seams and they are both useful:

- `server/terminal-latency.test.ts`
  - real PTY/server transport RTT assertions
  - current localhost benchmark budget:
    - `p50 < 7ms`
    - `p90 < 10ms`
    - `avg < 8ms`
    - at most `1` sample `>= 15ms`
    - `max < 25ms`
- `src/lib/terminalLatency.ts`
  - opt-in browser probe and stage timing for live debugging
  - tracks:
    - input queue-to-buffer timing
    - input buffer-to-send timing
    - output receive-to-write timing
    - probe-based round-trip timing
- `scripts/profile-terminal-input-latency.mjs`
  - quiet and noisy-background browser profiling against a real local server
  - warms the trace path before measurement so the first real samples are not clock-sync/setup noise
  - useful for checking whether latency is in the client buffer/send path or after transport send
  - the noisy-background browser lab also waits for confirmed noisy output before asserting focused typing latency
- `electron/ipc/runtime-diagnostics.ts`
  - backend recovery counters for:
    - `noop`
    - `delta`
    - `snapshot`
    - cursor-delta vs tail-delta splits
  - useful when proving that rapid switching and backpressure recovery are not falling back to
    destructive terminal snapshots

For local browser diagnosis, enable the probe in devtools before interacting with a terminal:

- `window.__TERMINAL_PERF__ = true`

Then use the exported helpers from `src/lib/terminalLatency.ts` in the console or a temporary
debug script to inspect current stats.

For follow-up ideas on stronger invariant testing, lifecycle reconciliation, and future
terminal/browser-control reliability work, see
[TERMINAL-INFRA-FOLLOW-UPS.md](./TERMINAL-INFRA-FOLLOW-UPS.md).

### Product Behavior

The Solid screen suite should continue to prove that:

- task actions open the right dialogs and recover correctly
- preview expose dialogs reset and validate correctly across reopen
- terminal views start, clean up, and react to state changes correctly
- sidebar actions trigger the right flows
- task rows surface compact attention and review state without overpowering the task list
- changed-files and review views react to pushed git state correctly
- remote access UI reacts to pushed status and host startup behavior correctly
- task attention state stays aligned with backend supervision and lifecycle fallbacks
- review signals reflect convergence state without diverging from the canonical task list
- review summaries reflect canonical merge-readiness and overlap signals

## Browser E2E Guidance

The browser lab is a small Playwright suite for the standalone browser/server path. It is meant to
cover the seams that jsdom and node-only integration tests do not see well:

- auth/bootstrap into the browser shell
- first terminal mount and loading states
- fixture-driven TUI smokes in a real browser
- reload/restore with warm scrollback
- representative multi-client takeover and passive read-only behavior

Current entrypoint:

- `npm run test:browser:e2e`

Related helpers and config:

- `playwright.config.ts`
- `tests/browser/harness/fixtures.ts`
- `tests/browser/harness/scenarios.ts`
- `tests/browser/harness/standalone-server.ts`

For the practical workflow around rebuilding artifacts, choosing the right harness helpers, using
terminal status history, and debugging recovery/latency issues, read
[TERMINAL-DEVELOPMENT-GUIDE.md](./TERMINAL-DEVELOPMENT-GUIDE.md).

Non-obvious rule:

- prefer the scripted terminal entrypoints over a hand-managed standalone server when debugging
  browser-terminal behavior locally; the scripted paths avoid stale-build/stale-server confusion

Important constraints:

- the suite runs against the compiled standalone browser server, not `vite preview`
- each test seeds its own temporary browser-server state and git repo fixture
- the harness uses real auth bootstrap via `/?token=...`
- build artifacts must exist before Playwright starts; the npm scripts build them first
- the standalone browser harness now also fails fast if the built `dist`, `dist-remote`, or
  `dist-server` artifacts are older than the relevant source trees; do not trust browser-lab
  results from stale builds

If Chromium is not installed for Playwright yet, run:

- `npx playwright install chromium`

Current browser-lab coverage is intentionally focused, not exhaustive. The main gaps still worth
adding are:

- browser-side resize-authority scenarios with different-width tabs
- alt-screen and repaint-loop flicker regressions
- explicit attach-scheduler budget assertions
- browser memory and replay-cost assertions for heavier restore scenarios

If a change touches resize authority or attach-priority behavior, current coverage is still not
enough to treat the work as done without adding browser-lab proof or equivalent new validation.

### Startup, Persistence, And Reconciliation

The integration tests around startup and persistence should continue to prove that:

- early pushed events are not lost during boot
- buffered startup events are dropped if the session is disposed before boot completes
- state is saved on the relevant lifecycle boundaries
- legacy persisted state still hydrates correctly
- corrupted persisted data is handled safely
- full-state and workspace-state restore keep using the same canonical project/task hydration helpers
- browser-local selection and layout state stay local when shared workspace state changes
- reconnect restores shared workspace state and task command controller snapshots without destructive full reloads

Representative files:

- `src/app/desktop-session.test.ts`
- `src/domain/task-closing.test.ts`
- `src/store/persistence.test.ts`
- `src/store/client-session.test.ts`
- `src/runtime/browser-session.runtime.test.ts`

### Multi-Client Collaboration And Control

The collaboration seams should now continue to prove that:

- shared workspace persistence does not reintroduce cross-client selection syncing
- browser-local session state survives foreign workspace saves and reconnect
- peer presence snapshots and joined-session projections replay correctly on reconnect
- display-name-driven ownership labels remain stable across reload and reconnect
- task command leases stay exclusive across merge, push, close, collapse, restore, and prompt dispatch
- task command controller snapshots replay on reconnect and live updates project into the renderer
- takeover request / response / timeout flows stay explicit:
  - owner approval and denial
- hidden-owner timeout auto-approval
- active-owner timeout requiring force takeover
- multiple simultaneous requests kept distinct by request id
- stale task-controller snapshots from one transport plane must not overwrite newer ownership from
  another plane; controller version ordering belongs in the store projection, not in terminal UI
  heuristics
- terminal input control and task command control remain separate concerns:
  - websocket agent-controller leases gate interactive stream input
  - task command leases gate task-scoped workflow mutations
- passive read-only UI should be the steady state for observers rather than repeated prompt spam

Representative files:

- `src/domain/task-command-controller-projection.test.ts`
- `src/domain/task-command-owner-status.test.ts`
- `electron/ipc/task-command-leases.test.ts`
- `electron/ipc/task-command-lease-handlers.test.ts`
- `server/browser-control-plane.test.ts`
- `src/app/task-command-lease.test.ts`
- `src/app/task-workflows.control.test.ts`
- `src/store/task-command-controllers.state.test.ts`
- `src/runtime/browser-presence.test.ts`
- `src/remote/remote-collaboration.test.ts`
- `src/remote/remote-presence.test.tsx`
- `src/runtime/browser-session.runtime.test.ts`
- `server/terminal-latency.test.ts`

## Current Philosophy Around Server-Owned State

For state the server is responsible for, the preferred model is:

1. backend detects or computes the canonical state
2. backend pushes or replays that state
3. clients project it into UI state
4. targeted refetch is a fallback, not the primary ownership model

This especially applies to:

- git status
- remote access status
- task attention / agent supervision
- task port observation and exposure
- branch-review and convergence inputs derived from git state
- replayable browser control-plane state

Tests should reinforce that ownership model rather than encoding client polling as the desired behavior.

## What To Add Next

The highest-value remaining testing work is:

1. browser-lab resize-authority scenarios with two tabs at different widths on the same terminal
2. alt-screen, repaint-loop, and flicker-focused browser specs for reconnect and restore
3. attach-scheduler assertions proving the active terminal becomes interactive before deferred
   terminals finish attaching
4. deeper browser-lab multi-client churn:
   - visibility changes
   - reconnect during takeover
   - roster churn
   - timeout and force-takeover transitions
5. heavier browser performance assertions around replay size, restore duration, and heap pressure
6. deploy smoke tests for standalone browser mode and auth/bootstrap behavior
7. more keyboard/focus/navigation behavior tests where task and sidebar flows evolve
8. app-level coverage for task preview flows and detected-port suggestion behavior as preview
   support grows

## Headless Stress Harnesses

Use the stress harnesses when you need to surface multi-user fanout, restore amplification, or
hot-session terminal delivery issues without relying on the UI.

These harnesses are the main validation seam when a change needs proof under latency, volume, or
session scale rather than just local correctness.

Fast seams:

- `npx vitest run --config vitest.config.ts tests/contracts/control-plane-stress.contract.test.ts`
- `npx vitest run --config vitest.config.ts server/session-stress.test.ts`

Raw runner:

- `npm run stress:session -- --users 3 --terminals 12 --lines 40 --reconnects 1`
- `node scripts/session-stress.mjs --print-profiles`
- `node scripts/session-stress.mjs --profile pr_smoke --skip-build --output-json tmp/session-stress-pr-smoke.json --quiet`
- `npm run stress:session -- --users 8 --terminals 12 --lines 120 --output-line-bytes 4096 --input-chunks 48 --input-chunk-bytes 4096 --mixed-lines 60 --mixed-line-bytes 4096`
- `npm run stress:session -- --users 8 --terminals 16 --input-chunks 24 --input-chunk-bytes 32768 --mixed-lines 40 --mixed-line-bytes 8192`
- `npm run stress:session -- --users 6 --terminals 12 --warm-scrollback-lines 120 --warm-scrollback-line-bytes 4096 --late-joiners 2 --late-join-live-lines 12 --late-join-live-line-bytes 2048`
- `npm run stress:session -- --users 4 --terminals 16 --lines 80 --reconnects 2 --latency-ms 40 --jitter-ms 20 --packet-loss 0.02`

Shared profile source:

- `scripts/session-stress-profiles.mjs`
- `node scripts/session-stress.mjs --print-profiles`
- `node scripts/session-stress-matrix.mjs --list-profiles`
- `node scripts/session-stress-matrix.mjs --list-matrices`
- `node scripts/session-stress-matrix.mjs --matrix slow_link_tuning --repeats 3 --allow-budget-failures --out-dir artifacts/session-stress/manual-slow-link-tuning`

Named profile and matrix commands:

- `npm run stress:session:smoke`
- `npm run stress:session:profile:steady-fanout`
- `npm run stress:session:profile:heavy-tui`
- `npm run stress:session:profile:reconnect-storm`
- `npm run stress:session:profile:late-join`
- `npm run stress:session:profile:slow-link`
- `npm run stress:session:tune:slow-link`
- `npm run stress:session:matrix`
- `npm run stress:session:prod-gate`

Direct runner and matrix entrypoints:

- `node scripts/session-stress.mjs --profile heavy_tui --output-json artifacts/session-stress/heavy-tui.json --fail-on-budget`
- `node scripts/session-stress-matrix.mjs --matrix production --out-dir artifacts/session-stress/manual-production`
- `node scripts/session-stress-matrix.mjs --profile heavy_tui --profile slow_link --out-dir artifacts/session-stress/manual-pair`
- `node scripts/session-stress-matrix.mjs --matrix production --out-dir artifacts/session-stress/tuned -- --users 8 --terminals 16`
- `node scripts/session-stress-matrix.mjs --matrix slow_link_tuning --repeats 3 --allow-budget-failures --out-dir artifacts/session-stress/tuned-slow-link`

Late-join profiles are intentionally split now:

- `late_join` is the stricter VM-local or direct-server budget for tuning the server/runtime itself
- `late_join_public` is the WAN/public-path budget for real-client validation through nginx/TLS and the public route
- `production` uses `late_join`
- `production_public` uses `late_join_public`

The raw runner now owns named profile selection, JSON artifact writing, budget evaluation, and analysis metadata through `--profile`, `--output-json`, and `--fail-on-budget`. The matrix wrapper consumes that shared contract instead of re-defining workloads locally. It expands shared matrices into profiles, forwards generic runner overrides after `--`, and writes `matrix-summary.json` alongside the per-profile JSON artifacts.

## Terminal Rendering Lab

Use the deterministic PTY fixtures in `scripts/fixtures/` when you need to investigate:

- bad first-fit or wrapped-on-one-line rendering
- prompt readiness before the terminal is visually stable
- status-line redraw glitches
- wide-character or emoji width bugs
- scrollback restore and late-join replay behavior

Available fixtures:

- `node scripts/fixtures/tui-wrap.mjs [repeatCount] [lineWidth]`
- `node scripts/fixtures/tui-burst.mjs [lineCount] [lineWidth]`
- `node scripts/fixtures/tui-widechars.mjs`
- `node scripts/fixtures/tui-statusline.mjs [frameCount] [delayMs]`
- `node scripts/fixtures/tui-prompt-ready.mjs [delayMs]`
- `node scripts/fixtures/tui-scrollback.mjs [lineCount] [lineWidth]`

Recommended manual/browser regression workflow:

1. Start the app in browser mode or Electron mode with a clean session.
2. Create one shell task and run each fixture directly in the terminal.
3. Repeat the same fixture in:
   - the first terminal that mounts after page load
   - a second terminal that mounts later
   - a hidden or background tab that becomes visible
   - a reload/restore path with warm scrollback
   - a narrow split and a wide split
4. For collaboration-specific issues, open the same task in two browser sessions:
   - one controller
   - one observer
   - type in the controller session while the observer stays read-only
   - take over from the observer session
5. For restore bugs, run `tui-scrollback.mjs`, reload, and observe the restored viewport before typing.

High-value experiments:

- first-fit wrap check:
  - `node scripts/fixtures/tui-wrap.mjs 3 200`
- status-line redraw:
  - `node scripts/fixtures/tui-statusline.mjs 120 25`
- prompt stabilization:
  - `node scripts/fixtures/tui-prompt-ready.mjs 200`
- deep scrollback:
  - `node scripts/fixtures/tui-scrollback.mjs 2000 120`
- wide-char rendering:
  - `node scripts/fixtures/tui-widechars.mjs`

What to look for:

- characters stacked vertically or wrapping at the wrong column
- terminal output rendering before the viewport has settled
- status lines leaving stale text behind
- emoji/CJK columns drifting
- restored scrollback repainting incorrectly after reload or reconnect
- observer sessions showing repeated takeover prompts instead of passive read-only state

Capture guidance:

- take screenshots of the first terminal and the second terminal for the same fixture
- note whether the issue reproduces only on cold load or also after reload
- include the fixture command, viewport width, and whether the tab was initially hidden

Use `--repeats <n>` on the matrix wrapper when you need stable threshold comparisons instead of a single noisy sample. Repeated runs write one artifact per run and aggregate averages in `matrix-summary.json`.

### Live Server Diagnostics And Remote Stress

Use the same tooling against a deployed browser server when you need to compare localhost and real-network behavior directly.

Runtime diagnostics watcher:

- `npm run diagnostics:watch -- --server-url https://yrsh-vm1.duckdns.org --auth-token <token> --samples 10 --interval-ms 2000`
- `node scripts/runtime-diagnostics-watch.mjs --server-url https://yrsh-vm1.duckdns.org --auth-token <token> --reset-on-start --reset-after-sample`

Remote bootstrap smoke:

- `npm run smoke:remote -- --server-url https://yrsh-vm1.duckdns.org --auth-token <token>`

Use this first when mobile or `/remote` looks broken. It exercises the real `/remote?token=... -> /remote/` bootstrap and fails if the page falls back to `Not authenticated` or never opens a websocket.

Remote raw runner:

- `node scripts/session-stress.mjs --server-url https://yrsh-vm1.duckdns.org --auth-token <token> --profile pr_smoke --quiet --output-json tmp/session-stress-remote-pr-smoke.json`
- `node scripts/session-stress.mjs --server-url https://yrsh-vm1.duckdns.org --auth-token <token> --profile slow_link --fail-on-budget --output-json artifacts/session-stress/remote-slow-link.json`
- `node scripts/session-stress.mjs --server-url https://yrsh-vm1.duckdns.org --auth-token <token> --profile late_join_public --fail-on-budget --output-json artifacts/session-stress/remote-late-join-public.json`

Remote matrix runs:

- `node scripts/session-stress-matrix.mjs --matrix production --out-dir artifacts/session-stress/remote-production -- --server-url https://yrsh-vm1.duckdns.org --auth-token <token>`
- `node scripts/session-stress-matrix.mjs --matrix production_public --out-dir artifacts/session-stress/remote-production-public -- --server-url https://yrsh-vm1.duckdns.org --auth-token <token>`
- `node scripts/session-stress-matrix.mjs --matrix slow_link_tuning --repeats 3 --allow-budget-failures --out-dir artifacts/session-stress/remote-slow-link-tuning -- --server-url https://yrsh-vm1.duckdns.org --auth-token <token>`

Deployment-time logging:

- `RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS=5000`
- `RUNTIME_DIAGNOSTICS_LOG_RESET=true`

When `RUNTIME_DIAGNOSTICS_LOG_INTERVAL_MS` is set on the browser server, `server/main.ts` emits one structured runtime-diagnostics log line every interval. Set `RUNTIME_DIAGNOSTICS_LOG_RESET=true` if you want each sample to be per-interval instead of cumulative.

When you run the diagnostics watcher alongside the stress harness and you want the harness JSON artifact to preserve cumulative per-phase counters, avoid `--reset-after-sample`. Use `--reset-on-start` only, or run the watcher in JSON mode without resets.

The remote stress runner now creates a unique `taskId` per run, so repeated or concurrent stress sessions do not all reuse the same fixed task identity on the target server.

### Nginx Deployment Guidance

When you expose the browser server through nginx, keep the reverse-proxy policy explicit and low-overhead.

Recommended structure:

- use an `upstream` for the browser server, for example `127.0.0.1:3002`
- enable upstream keepalive on that `upstream`
- keep `/ws` in its own location with websocket upgrade headers
- keep `/api/ipc/` in its own location so request/response IPC does not share the websocket header policy
- keep `proxy_buffering off` and `proxy_request_buffering off` for `/ws` and `/api/ipc/`
- set explicit long-lived timeouts for proxied traffic:
  - `proxy_read_timeout`
  - `proxy_send_timeout`
  - `send_timeout`
- enable `proxy_socket_keepalive on` on the proxied locations

Recommended nginx shape:

```nginx
upstream parallel_code_upstream {
    server 127.0.0.1:3002;
    keepalive 64;
}

location /ws {
    proxy_pass http://parallel_code_upstream/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400s;
    proxy_send_timeout 3600s;
    send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_socket_keepalive on;
}

location /api/ipc/ {
    proxy_pass http://parallel_code_upstream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_socket_keepalive on;
}

location / {
    proxy_pass http://parallel_code_upstream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_socket_keepalive on;
}
```

Validation checklist after an nginx change:

1. `sudo nginx -t`
2. `sudo systemctl reload nginx`
3. confirm the browser server is still reachable directly on localhost
4. confirm the public host still returns `get_backend_runtime_diagnostics`
5. rerun `pr_smoke` and `late_join_public`

If VM-local watcher samples stay mostly quiet while public-path runs still show `ETIMEDOUT` or large skew, the remaining issue is more likely edge/public-path connectivity than server-side transport saturation.

### Production-Readiness Profiles

Use the shared `production` matrix for release readiness. It currently expands to these profiles:

- `steady_fanout`
  validates steady hot-session fanout without reconnect, replay, or heavy input noise
- `heavy_tui`
  validates concurrent output and input pressure for TUI-style sessions
- `reconnect_storm`
  validates repeated reconnect and restore waves against a hot session
- `late_join`
  validates warm scrollback replay and live delivery for fresh users joining late
- `slow_link`
  validates the same session behaviors under simulated latency, jitter, and retransmission-style loss

Use the `smoke` matrix for fast confidence checks. It currently runs:

- `pr_smoke`
  fast shared-session sanity coverage for PRs and local verification

Use the `slow_link_tuning` matrix when you want to tune browser-channel degraded-mode settings under shaped network pressure. It currently compares these threshold variants over the same slow-link workload:

- `slow_link_drain_25_passes_2`
- `slow_link_drain_25_passes_6`
- `slow_link_drain_50_passes_2`
- `slow_link_drain_50_passes_4`
- `slow_link_drain_50_passes_6`

The exact CLI args and budget thresholds for those profiles live in `scripts/session-stress-profiles.mjs`. Keep that file as the source of truth and use the docs here to choose the right profile or matrix for the job.

### Release Gate And Matrix Workflow

Use the release gate when shared-session transport, replay, or hot-session PTY behavior is part of a release decision.

Release gate command:

- `npm run stress:session:prod-gate`

What it does:

- runs the shared `production` matrix
- writes one JSON artifact per profile plus `matrix-summary.json` under `artifacts/session-stress/prod-gate`
- exits non-zero if a profile run fails or if the raw runner reports a budget failure

Use the broader matrix command when you want smoke plus production coverage in one sweep:

- `npm run stress:session:matrix`

For exploratory runs where you still want artifacts even if the current branch is over budget:

- `node scripts/session-stress-matrix.mjs --matrix production --out-dir artifacts/session-stress/experiment --allow-budget-failures`

Artifact workflow:

1. choose or create an output directory
2. run one or more shared profiles or matrices through `scripts/session-stress-matrix.mjs`
3. inspect `matrix-summary.json` first for aggregate pass/fail and per-profile artifact paths
4. open the per-profile JSON file when you need the raw runner `evaluation`, `analysis`, `meta`, or phase-by-phase summary details

Harness notes:

- `--lines 0`, `--input-chunks 0`, and `--mixed-lines 0` skip those phases entirely so you can isolate one part of the workload.
- reconnect sweeps reuse a stable browser `clientId` and `lastSeq` cursor so they exercise replay/restore behavior instead of only simulating fresh peers joining.
- `--warm-scrollback-lines` warms each terminal before the late-join phase so `get_scrollback_batch` exercises real replay cost.
- `--late-joiners` adds fresh users after the warm phase and measures scrollback restore pressure while live output continues.

Use the layers for different questions:

1. `control-plane-stress.contract.test.ts`
   proves broadcast fanout and slow-consumer isolation cheaply in-process
2. `server/session-stress.test.ts`
   proves a real server, real PTYs, multiple users, and channel fanout can survive a hot shared session
3. `scripts/session-stress.mjs`
   gives the raw parameter-sweep runner for ad hoc exploration
4. `scripts/session-stress-matrix.mjs`
   adds named workloads, artifact capture, and budget-based release gating around that raw runner

Watch these outputs first:

- burst wall-clock duration
- per-marker inter-client skew
- total websocket messages and bytes per run
- reconnect burst cost compared to the initial burst
- late-join connect/bind time
- late-join scrollback replay wall-clock time and returned bytes
- backend `ptyInput` diagnostics such as `enqueuedMessages`, `coalescedMessages`, `flushes`, and `maxQueuedChars`
- backend `scrollbackReplay` diagnostics such as `batchRequests`, `requestedAgents`, `returnedBytes`, and `lastDurationMs`
- backend `browserControl` diagnostics such as `backpressureRejects`, `delayedQueueMaxDepth`, `delayedQueueMaxBytes`, `delayedQueueMaxAgeMs`, and `notOpenRejects`
- backend `browserChannels` diagnostics such as `coalescedMessages`, `coalescedBytesSaved`, `degradedClientChannels`, `droppedDataMessages`, `maxQueueAgeMs`, and `transportBusyDeferrals`

If a shared-session regression appears in the browser, reproduce it with the headless harness before tuning UI code. This keeps the investigation focused on transport, replay, restore, PTY, or fanout ownership instead of frontend noise.

Use the phases for different questions:

1. output phase
   isolates channel fanout and shared-session delivery cost
2. input phase
   isolates browser-control input volume, PTY queueing, and paste-like bursts
3. mixed phase
   isolates TUI-style concurrent input/output pressure on the same hot session
4. late-join scrollback phase
   isolates scrollback replay cost and its impact on live users already attached to the hot session

Recent lesson:

- heavy browser input above the old websocket parser ceiling was being silently dropped until the stress harness started sending multi-kilobyte writes
- after that fix, the next real cliff was slow-link channel backpressure under many shared terminals, not PTY input loss
- pure degraded-mode threshold tuning only moves the problem around; once local channel queues are healthy, the next bottleneck is usually the delayed browser transport queue itself
- the current tuned default point is a `25ms` browser-channel drain interval with `2` degraded drain passes; rerun the slow-link sweep before changing that again
- when tuning slow-link thresholds, prefer the shared `slow_link_tuning` matrix with `--repeats 3` or higher so you compare averages instead of one lucky run

## Porting Upstream Tests

When porting upstream changes, do not copy tests mechanically just because the feature is similar.

Port tests by local seam:

1. if the behavior is backend-owned here, test it in the node suite even if upstream proved it through a UI test
2. if the behavior is renderer-only here, prefer a Solid test even if upstream proved it through a broader integration path
3. if the port crosses backend, workflow, and UI boundaries here, split proof across the relevant seams instead of forcing one giant copied test

Good ported tests prove:

- the same user-visible behavior
- the correct local authority model
- the timing/replay/recovery expectations of this repo

Bad ported tests prove:

- the old upstream file layout still exists
- the old upstream helper graph is still present
- a copied test happens to pass while missing the real local ownership seam

When in doubt, ask:

- where does this behavior live in this repo now?
- what is the thinnest test that proves it at that seam?

## Timer Hygiene

Timer-driven node tests should be defensive about suite order and cleanup.

Use these rules whenever a test relies on `vi.useFakeTimers()`:

1. force `vi.useRealTimers()` in `beforeEach` so the test does not inherit timer state from a previous case
2. clear timers and restore real timers in `afterEach`
3. clean up long-lived intervals or background timers in `finally` blocks when the test can fail before the normal teardown path
4. prefer `await vi.advanceTimersByTimeAsync(...)` when the code under test can queue follow-up microtasks
5. when a test is asserting "the next drain tick" or "the next retry pass", prefer a tiny named helper
   that advances exactly that timer boundary instead of `runOnlyPendingTimersAsync()`, which can hide
   unrelated timers and make queue tests suite-order sensitive

This matters most for:

- websocket heartbeat loops
- startup/replay flows
- retry/backoff logic
- browser control-plane queue draining

The goal is to keep timer-based tests deterministic in isolation and under the full suite.

## Shared Harness Hygiene

Some runtime and startup tests use shared mock registries for listeners, window events, or replay callbacks.

When those harnesses change, follow these rules:

1. cleanup should remove the exact listener that was registered, not just "whatever is currently stored for this event name"
2. readiness waits should target the real completion signal for the behavior under test, not the earliest incidental call in the startup chain
3. if a failure appears only under the full suite, rerun the file in isolation first, then fix the harness cause instead of broadening timeouts
4. if the module under test keeps retained sessions, retry queues, or subscriptions in module scope,
   add a typed test reset helper or re-import the module per test so cleanup is explicit and reviewable

This matters most for:

- startup and restore sequencing
- browser reconnect and replay
- terminal/control-plane lease helpers
- HTTP retry and reconnect queues
- preview and remote-access listener wiring

## Handler And Persistence Boundary Tests

When transport, handler typing, or saved-state parsing changes, add direct node tests for the boundary itself.

Use these rules:

1. request-bearing IPC handlers should prove that missing required payloads fail as `BadRequestError`
2. explicitly optional request channels should prove that omitted payloads still take the intended default path
3. shared persisted-state parsers should prove legacy, partial, and empty fragments normalize the same way for every consumer
4. if a restore path intentionally ignores fields like display-only names, cover that with a direct regression instead of relying on a broader startup test

These tests are valuable because they keep request-shape drift and saved-state drift from hiding behind larger integration flows.

## What To Avoid

Avoid adding tests that only prove:

- a specific helper was called
- a specific implementation detail still exists
- a temporary polling path still fires on schedule

Those tests are sometimes useful locally, but they are not the main quality bar for this codebase.
