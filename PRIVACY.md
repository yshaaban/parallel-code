# Privacy And Security

Parallel Code is a local developer tool that can also run as a browser-accessible server. It gives
connected browsers live access to project state, terminals, previews, and task actions after
authentication. Treat a browser/server deployment like access to a development machine, not like a
read-only dashboard.

## What Stays Local

Parallel Code does not run a hosted service for your projects. In normal use, your projects,
worktrees, terminal output, task state, and browser-mode server state stay on the machine where you
run the app or standalone server.

The app stores local workspace state so it can restore projects, tasks, terminal sessions, layout,
and preferences after restart. Browser sessions also keep local client preferences such as selected
task, display name, and UI state in browser storage.

## Terminal And Agent Data

Agent terminals are real PTYs. Anything visible in a terminal, typed into a terminal, pasted into a
terminal, or emitted by an agent is handled by the local backend and may be sent to authenticated
browser clients that are connected to the same Parallel Code server.

AI coding CLIs such as Claude Code, Codex CLI, Gemini CLI, Antigravity, OpenCode, or custom commands
have their own network behavior and privacy policies. Parallel Code launches those tools; it does
not control what they send to their providers.

## Browser And Remote Access

Browser mode serves the desktop UI at `/` and the mobile remote UI at `/remote`. Authenticated
clients can view task state, send terminal input when they hold the task command lease, interact
with remote terminal controls, and open authenticated task preview routes.

Access is protected by an access token. Local development defaults come from `.env.example` so the
URL is stable on a fresh checkout, but you must set a different `AUTH_TOKEN` before exposing the
server beyond local development.

The server accepts tokens through the auth form, bearer auth, or the `token` query parameter. Query
tokens are convenient for local setup and QR-code flows, but they can appear in browser history,
logs, screenshots, copied URLs, and tunnel access logs. After query-token login, the browser auth
flow strips the token from the URL and uses an HTTP-only session cookie for the shell.

## Preview Proxy

When you explicitly expose a task port, browser mode proxies it through authenticated task-scoped
preview routes. The preview proxy removes Parallel Code authorization and session cookies before it
forwards requests to the target app, then rewrites paths and cookies so the preview works under the
task-scoped route.

Only expose ports you expect connected users to access. A preview target is still your running
development app, with whatever data and side effects that app allows.

## Project Discovery

Parallel Code can discover recent projects from local workspace state and compatible CLI history.
Discovery is bounded and filters volatile temporary paths, but suggested paths can still reveal
local directory names to authenticated browser clients. Do not expose browser mode to people who
should not know what projects exist on the host.

## Runners, Containers, And Environment

Host execution is the default. Docker runner profiles and task container features are opt-in and
backend-owned. Runner environment forwarding blocks high-risk process-control variables such as
`PATH`, `HOME`, `SHELL`, `USER`, `NODE_OPTIONS`, and dynamic-library injection hooks.
Docker agent runners can still forward the default credential allowlist into the container when
those variables exist on the host: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_HOME`,
`GEMINI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, and `OPENAI_API_KEY`.

Custom commands run with the privileges and filesystem access of the configured runtime. Review a
custom command the same way you would review a shell command before launching it.

## Markdown, Diffs, And Links

Plan and markdown viewers render local content through the app's markdown pipeline. External links
remain external links when opened. QR codes intentionally use literal black and white colors for
scan reliability.

## Operational Guidance

- Use browser mode on trusted networks or behind your own tunnel/VPN/auth gateway.
- Rotate `AUTH_TOKEN` if a URL with `token=` was shared beyond the intended audience.
- Prefer HTTPS when exposing the browser server outside localhost.
- Treat authenticated browser clients as capable collaborators, not passive viewers.
- Stop the server or revoke tunnel access when remote access is no longer needed.
