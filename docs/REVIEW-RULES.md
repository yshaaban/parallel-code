# Review Rules

Use this document when reviewing non-trivial changes in Parallel Code, especially:

1. upstream ports and parity work
2. browser-mode transport, auth, reconnect, restore, or persistence changes
3. preview and exposed-port behavior
4. test harness changes that can affect suite-order stability

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) for ownership rules and [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for the upstream-port workflow. Use this file as the practical review checklist and lessons-learned record.

## Required Review Pass

For any non-trivial change, review in this order:

1. map the behavior to the local owner:
   - backend
   - handler / transport
   - workflow / app
   - store / projection
   - presentation
2. identify the failure mode if the change is wrong:
   - stale truth
   - replay drift
   - auth / reconnect churn
   - preview / port mismatch
   - suite-order flake
3. choose the validation seam:
   - node / backend
   - runtime / integration
   - Solid / UI
   - docs / sanity only
4. run the full gate after targeted green if the change touches runtime, preview, persistence, or shared test harnesses

Do not review a port only by comparing file shape to upstream. Review whether the behavior landed in the correct local owner.

## Browser Runtime Review Rules

When a change touches browser mode, explicitly verify:

- reconnect does not start restore before authenticated control traffic is confirmed
- restore and replay do not run on raw socket state alone
- persistence fast paths do not skip required side effects like project-path validation
- no-op sync optimizations do not remount terminals or recreate task / agent state
- auth-expired, reconnect, and connected states still preserve clear ownership between transport and workflow layers

If any of those are unclear, add or update runtime tests before treating the change as review-ready.

## Preview And Port Review Rules

When a change touches preview or observed ports, explicitly verify:

- terminal-output parsing is treated as a hint, not canonical truth
- noisy shell fragments are sanitized without trimming legitimate URL syntax
- authenticated preview routing preserves nested paths and static assets
- preview UI density changes do not hide state transitions or error handling
- new exposure flows distinguish task-owned observed ports from dialog-local scan suggestions

For parser changes, add at least one regression for:

1. the broken real-world string
2. a nearby valid string that must stay intact

## Test Harness Review Rules

When a review uncovers suite-order flake, prefer fixing the harness cause instead of raising timeouts.

Check for:

- timer state inherited across tests
- background intervals not cleaned up in `finally`
- listener cleanup keyed only by channel name instead of listener identity
- tests waiting for weak intermediate signals instead of real completion signals
- async startup work from one test still mutating shared mocks in the next test

If the failure only appears in the full suite, rerun the smallest affected file first, then the full gate again after the harness fix.

## IPC And Persistence Review Rules

When a change touches renderer invoke typing, handler validation, or persisted-state parsing, explicitly verify:

- required request channels stay required in the shared request map instead of being widened to `undefined` for transport convenience
- optional request channels are explicit and mirrored by the handler-side allowlist or guard path
- malformed handler input is classified as `BadRequestError`, not a generic internal error
- repeated saved-state fragments are parsed through one shared parser or type source instead of local `JSON.parse(...) as ...` copies
- restore paths only tolerate partial persisted fragments where the canonical parser says they should

If any of those drift, add or update direct node tests before treating the change as review-ready.

## Recent Lessons Worth Reusing

### 1. Reconnect restore must wait for authenticated control traffic

A raw websocket `connected` event is not enough to treat browser restore as safe. On deployed servers, that can start replay too early and create `check_path_exists`, `list_running_agent_ids`, and `spawn_agent` churn.

Review rule:

- browser restore should start from confirmed authenticated control traffic, not from transport open alone

### 2. No-op persistence fast paths still need reconciliation side effects

Skipping an identical persisted JSON payload is fine, but not if it also skips follow-up checks that keep derived state fresh.

Review rule:

- if a sync path becomes a no-op for durable state, re-check whether validation, path refresh, or diagnostics still need to run

### 3. Port sanitizers must preserve real URLs while dropping shell noise

Shell fragments like `2>&1)` or pasted curl flags should not survive into observed-port suggestions. But valid path characters like `&` inside a real URL should not be stripped either.

Review rule:

- every parser hardening change needs both a broken-string regression and a nearby valid-string preservation test

### 4. Listener cleanup must be identity-aware in shared test harnesses

If a test mock removes listeners by event name only, stale async cleanup from one test can delete the next test's listener and create non-reproducible timeouts.

Review rule:

- test harness cleanup for listeners should remove only the exact listener that was registered

### 5. Wait for completion signals, not incidental calls

`loadState()` being called is often too early to prove startup completed. Prefer waiting for the actual post-startup signal the test claims to assert.

Review rule:

- choose the readiness assertion that matches the behavior under review, not the earliest call in the chain

### 6. Required IPC payloads should stay exact

It is easy to loosen request typing just to make a transport helper convenient. That hides real request-shape drift and turns malformed calls into late runtime failures.

Review rule:

- keep required request payloads required in the shared invoke map, make optional channels explicit, and reject missing required payloads as bad requests at the handler boundary

### 7. Persisted-state parsing should be shared once

When multiple restore or watcher paths parse the same saved-state fragment independently, they drift quietly and recover different subsets of state.

Review rule:

- if more than one path needs the same persisted fragment, parse it once through a shared parser and reuse that canonical shape everywhere

## What To Update With The Code

If the change is non-trivial, update the docs in the same branch:

- [UPSTREAM-DIVERGENCE.md](./UPSTREAM-DIVERGENCE.md) for upstream parity status, port classification, or new lessons from an upstream sync
- [TESTING.md](./TESTING.md) when the change teaches a reusable testing rule
- [AGENTS.md](../AGENTS.md) or [CLAUDE.md](../CLAUDE.md) when contributor or agent workflow rules changed

The goal is to leave behind a repeatable review rule, not just a one-off fix.
