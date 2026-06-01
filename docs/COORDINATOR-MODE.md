# Coordinator Mode

Coordinator mode is the browser-server implementation of background task orchestration. It lets a
user start one visible coordinator agent and give that agent a backend credential for spawning,
prompting, and landing hidden subtasks.

This is not a port of upstream MCP coordinator code. The local design keeps orchestration backend
owned, replayable, and browser-first.

## Support Boundary

Coordinator mode is available from the browser server runtime. Electron-only runs do not expose the
tool-call gateway, so the New Task dialog keeps the option unavailable there.

Coordinator mode currently requires host-run agents. Docker runner profiles are rejected because
the credential file and loopback tool URL are host resources; container-safe credential mounting and
network policy need a separate design.

## Runtime Shape

The backend owns coordinator runs in `electron/coordinator/*`.

- `runtime.ts` owns replayable run, subtask, prompt, landing, diagnostics, and idempotency state.
- `service.ts` owns persistence, credential files, token indexes, activity hints, and cleanup.
- `tool-gateway.ts` owns authorized tool execution and prompt delivery.
- `handlers.ts` exposes typed IPC handlers.

Browser mode exposes `POST /api/coordinator/tool-call`. The browser token is not the authority for
that endpoint; each tool call must include the per-task coordinator token from the credential file.

The helper command is exported to agents as `PARALLEL_CODE_COORDINATOR_TOOL` when a reachable
tool-call URL exists. The credential path is exported as `PARALLEL_CODE_COORDINATOR_CREDENTIAL`.

## Tools

The current tool surface is intentionally small:

- `get_task_status` returns the run snapshot.
- `spawn_subtask` creates a hidden task and hidden PTY-backed agent, then queues the assignment.
- `send_prompt` queues a prompt for a run-owned subtask.
- `signal_done` marks a subtask ready for review.
- `land_self` validates and lands a git-backed subtask into the coordinator project root.

Subtasks can call only subtask-owned tools. The coordinator task is the only caller allowed to spawn
subtasks or send prompts.

## Safety Rules

Coordinator credentials are bearer tokens and are stored only in per-agent credential files and the
backend token index. Snapshots expose `toolTokenId`, not the token.

Credentials are revoked when a coordinator parent task or subtask is removed through backend task
cleanup. Restored coordinator runs are marked `stale-after-restore` because hidden PTY sessions are
not reconstructed after a server restart.

Prompt delivery goes through the task-command lease path before writing to the PTY. It waits for
backend supervision to report `idle-at-prompt`, backs off while the agent is busy, and retries after
supervision or timer events. A prompt blocked by `awaiting-input` is left for the coordinator to
inspect instead of being force-written over a question.

Prompt queues are bounded per target subtask, and stable prompt/spawn dedupe keys are honored before
creating additional hidden tasks or queue entries. Subtask cleanup cancels queued prompts and
revokes the subtask credential before any later retry can write to the PTY.

`land_self` acquires the coordinator parent task command lease, checks child and parent git status,
merges, runs the real task deletion workflow for the hidden child, revokes the child credential, and
then records the landing result.

## Validation

Coordinator work should prefer browser-free tests first:

- domain guard tests for coordinator snapshots and events
- runtime tests for replayable state and restored stale status
- service tests for credentials, token lookup, revocation, and persistence
- tool-gateway tests for hidden spawn, prompt retry, authorization, and landing cleanup
- server-state bootstrap tests for coordinator snapshots and live events
- browser-control-client tests for `coordinator-event` dispatch

Use browser canaries only when a change crosses the actual browser server, websocket replay, or UI
creation path.
