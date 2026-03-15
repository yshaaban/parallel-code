# Parallel Code

Read these first:

- `AGENTS.md`
- `docs/ARCHITECTURAL-PRINCIPLES.md`
- `docs/UPSTREAM-DIVERGENCE.md`
- `docs/REVIEW-RULES.md`
- `docs/ARCHITECTURE.md`
- `docs/TESTING.md`

Stable project truths:

- Parallel Code runs in two modes: Electron and standalone browser/server.
- Backend owns external and canonical state.
- Renderer owns workflow orchestration and presentation.
- Transport is not business logic.
- Restore, replay, and persistence should preserve exact identity and ownership boundaries.
- Upstream work is ported by behavior and local owner, not by upstream file shape.

Use `README.md` for commands and product overview.
