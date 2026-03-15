# Agent Guidance

Use these documents as the required source of truth for architecture and upstream sync work:

- [docs/ARCHITECTURAL-PRINCIPLES.md](docs/ARCHITECTURAL-PRINCIPLES.md)
- [docs/UPSTREAM-DIVERGENCE.md](docs/UPSTREAM-DIVERGENCE.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/TESTING.md](docs/TESTING.md)

## Required Upstream Port Workflow

For any non-trivial upstream sync or parity change:

1. classify the upstream commit or feature slice:
   - `cherry-pick directly`
   - `manual port`
   - `reimplement on our architecture`
   - `skip/defer`
2. map the behavior to the correct local owner:
   - backend
   - handler / transport
   - workflow / app
   - store / projection
   - presentation
3. decide the validation seam:
   - node / backend
   - runtime / integration
   - Solid / UI
   - docs / sanity only

Do not:

- port by upstream file shape when ownership differs here
- let dialogs or leaf components become task-level policy owners
- move backend truth into renderer heuristics
- let transport glue become workflow or business logic

For non-trivial upstream sync work, update [docs/UPSTREAM-DIVERGENCE.md](docs/UPSTREAM-DIVERGENCE.md) so the reviewed head, parity picture, and remaining gaps stay accurate.
