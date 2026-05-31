# Task Container Environments

This document defines the V1 task-container feature.

Read [ARCHITECTURAL-PRINCIPLES.md](./ARCHITECTURAL-PRINCIPLES.md) first for ownership rules, then
use this document for the concrete container-environment contract.

## Classification

This feature is a `reimplement on our architecture`, not a direct upstream Docker-isolation port.

Upstream's Docker isolation work is desktop-local and focused on agent execution. This repo's V1
container feature is:

- backend-owned
- task/worktree-scoped
- Docker Compose only
- inspect-first
- preview-manager integrated

## Product Goal

For a task/worktree that contains a supported Compose project, the user can:

- inspect whether task-scoped containers are supported
- start the task-scoped Compose project
- stop it without destructive cleanup
- destroy owned runtime resources explicitly
- inspect recent logs
- open task-scoped preview links for declared app previews

## V1 Scope

V1 supports a small explicit subset of Docker projects:

- Docker Compose only
- one supported Compose file selected from:
  - `compose.yaml`
  - `compose.yml`
  - `docker-compose.yml`
  - `docker-compose.yaml`
- or one explicit repo-scoped override file via `Project.containerConfig.composeFile`
- task/worktree-scoped isolation through `COMPOSE_PROJECT_NAME`
- task-owned previews derived from declared preview intent or a single published port fallback

V1 does not support:

- Podman
- arbitrary `docker run` workflows
- custom script orchestration as the primary lifecycle
- multiple compose-file merge chains
- global fixed resource naming that defeats task isolation

## Ownership

### Backend

Files:

- `electron/ipc/task-containers.ts`
- `electron/ipc/task-container-identity.ts`

Responsibilities:

- task-container identity
- Compose support detection
- inspect/preflight result computation
- lifecycle planning and execution
- Docker Compose execution
- owned preview derivation
- logs retrieval

### Handler / transport

Files:

- `electron/ipc/task-container-handlers.ts`
- `src/domain/renderer-invoke.ts`
- `electron/ipc/channels.ts`

Responsibilities:

- typed IPC surface
- request validation
- no business logic beyond validation/routing

### Workflow / app

Files:

- `src/app/task-containers.ts`
- `src/components/task-panel/task-panel-preview-controller.ts`

Responsibilities:

- build task-scoped requests from project + worktree state
- coordinate inspect/log/action async sequencing for the preview manager
- suppress stale request results so older inspect/log/action completions cannot overwrite newer
  task truth
- own explicit inspect/log/action error state and clear stale action errors after fresh inspect
  truth arrives
- trigger task container actions from the preview manager

### Presentation

Files:

- `src/components/PreviewPanel.tsx`
- `src/components/TaskContainersPanel.tsx`

Responsibilities:

- render inspect status, issues, previews, services, and logs
- expose start/stop/destroy/refresh actions
- render workflow-owned error state instead of owning request sequencing or stale-result policy
- keep container previews distinct from task-port previews

## Workflow Contract

The task-panel preview controller owns async sequencing for task-container workflow calls.

Rules:

- `inspect`, `logs`, and lifecycle actions are sequenced by the controller, not by presentation
  components
- stale responses from older requests must be ignored
- failed `inspect`, `logs`, or lifecycle actions must surface explicit error state
- a fresh successful inspect clears stale action error state when it re-establishes current task
  truth
- presentation components render the workflow-owned status and error state, but they do not decide
  request order or overwrite protection

## Inspect Contract

`InspectTask` is the primary read operation.

Statuses:

- `not_configured`
- `unsupported`
- `ready`
- `running`
- `error`

Structured issue codes currently include:

- `compose_file_missing`
- `docker_unavailable`
- `compose_unavailable`
- `unsupported_runner_profile`
- `missing_required_env_file`
- `explicit_container_name`
- `named_network`
- `named_volume`
- `external_network_declared`
- `external_volume_declared`
- `fixed_host_port_conflict`
- `multiple_compose_files_unsupported`
- `unsupported_compose_feature`
- `compose_config_failed`
- `compose_status_failed`
- `task_worktree_missing`

The preview manager renders inspect results directly. It must not infer support or running state
from task-port discovery. It must surface inspect/log/action failures explicitly. A later successful
inspect should clear stale action-error state instead of leaving the UI stuck in an old error mode.

Missing Compose configuration is normal for browser-first task previews. When inspect returns
`not_configured` with only `compose_file_missing`, the preview manager should show neutral container
absence, not a primary preview failure. Task-port discovery still owns host listener suggestions in
this state.

Inspect also reports a backend-owned runner-profile resolution. With no configured runner profile,
the resolution is `not_configured` and falls back to the current Compose task-container profile.
An explicit Compose runner profile resolves normally. Docker runner profiles are recorded as
`unsupported` until a separate backend runner execution policy exists. Inspect/start/stop/destroy
must not fake Docker agent execution through the task-container lifecycle.

Opening the preview manager performs one initial task-port scan to populate available local
listeners. Later listener refreshes stay behind the explicit rescan action. This scan must not
start task containers, infer container support, or mutate container inspect truth.

Inspect, logs, and action failures are part of the workflow contract:

- the controller keeps those errors explicit
- the controller clears stale action errors after fresh inspect truth arrives
- presentation renders the explicit error state instead of collapsing it into a silent loading
  reset

## Identity Spec

Identity is backend-owned in `task-container-identity.ts`.

Rules:

- primary isolation key: `COMPOSE_PROJECT_NAME`
- deterministic slug from project basename + task id
- deterministic short hash from project path + worktree path + task id
- ownership labels as a safety belt:
  - `io.parallel-code.managed`
  - `io.parallel-code.project-path-hash`
  - `io.parallel-code.task-id`
  - `io.parallel-code.worktree-path-hash`

Compose identity is the primary way to inspect and control the task-scoped project. Labels make
cleanup and rehydration safer.

## Lifecycle Semantics

Operations:

- `InspectTask`
- `StartTask`
- `StopTask`
- `DestroyTask`
- `GetTaskLogs`

Semantics:

- `StartTask`
  - non-destructive
  - writes an override file with ownership labels
  - starts the Compose project with task-scoped identity
- `StopTask`
  - non-destructive
  - stops the running project without destroying owned resources
- `DestroyTask`
  - explicit cleanup path
  - currently runs Compose down with orphan cleanup
  - does not remove volumes explicitly in V1
- `GetTaskLogs`
  - backend-owned log snapshot
  - not a deep orchestration stream/control plane

## Unsupported Project Shapes In V1

Inspect should report `unsupported` when any of these are present:

- explicit `container_name`
- explicit global `network.name`
- explicit global `volume.name`
- external networks
- external volumes
- configured Compose file path outside the task worktree
- multiple root Compose files without an explicit configured choice
- missing required env files
- fixed host-port collisions that would break task-scoped isolation

## Preview Model

Task container previews are not the same as observed/exposed task ports.

Use these categories:

- `publishedPorts`
  - backend-observed published ports from the Compose project
- `previews`
  - user-meaningful app preview targets derived from:
    - `Project.containerConfig.previewPorts`
    - or a single published port fallback
- task-port previews
  - separate host-observed/exposed preview model owned by `task-ports`

The preview manager may render both categories, but they must stay distinct in trust and ownership.

## Testing Strategy

Primary proof belongs in `node / backend`:

- compose-file selection
- support detection
- identity generation
- unsupported compose shapes
- env-file resolution
- port-conflict promotion
- inspect/start/stop/destroy/log semantics

Required UI proof:

- preview-manager rendering and action wiring
- container previews remain distinct from exposed task ports
- rejection-path tests for inspect, logs, and lifecycle actions
- one stale-result invalidation test for preview-controller churn

Real Docker integration proof exists as an opt-in backend lane:

- set `RUN_DOCKER_INTEGRATION=1`
- run:
  - `npm run test:node:docker:integration`

Required Docker-capable pre-release proof uses:

- `npm run test:node:docker:integration:required`

That suite currently proves:

- real Compose inspect/start/stop/destroy/log behavior
- fixed host-port conflict detection against real Compose config parsing
- unsupported explicit `container_name` detection from real Compose config output
- configured preview derivation from declared `Project.containerConfig.previewPorts`
- task identity isolation across two worktrees of the same project

Normal PR runs may skip the opt-in lane when Docker integration is not under review. Use the
required Docker-capable script as pre-release proof whenever task-container runtime execution,
identity, cleanup, or preview derivation changes.

## Future Work

Deferred until after V1 is stable:

- Podman adapter
- richer repo-scoped project config UI
- explicit preview intent beyond port-based configuration
- broader real-runtime integration matrix
- more advanced health/stream orchestration
