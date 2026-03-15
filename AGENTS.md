# Agent Guidance

Use these documents as the source of truth:

- [docs/ARCHITECTURAL-PRINCIPLES.md](docs/ARCHITECTURAL-PRINCIPLES.md)
- [docs/UPSTREAM-DIVERGENCE.md](docs/UPSTREAM-DIVERGENCE.md)
- [docs/REVIEW-RULES.md](docs/REVIEW-RULES.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/TESTING.md](docs/TESTING.md)

For any non-trivial upstream sync or parity change:

1. classify it:
   - `cherry-pick directly`
   - `manual port`
   - `reimplement on our architecture`
   - `skip/defer`
2. map it to the correct local owner:
   - backend
   - handler / transport
   - workflow / app
   - store / projection
   - presentation
3. validate it at the correct seam:
   - node / backend
   - runtime / integration
   - Solid / UI
   - docs / sanity only

Do not:

- port by upstream file shape when ownership differs here
- move backend truth into renderer heuristics
- let transport glue become business logic
- let dialogs or leaf components become task-level policy owners

Keep the docs current:

- update [docs/UPSTREAM-DIVERGENCE.md](docs/UPSTREAM-DIVERGENCE.md) when reviewed upstream status or parity changes
- update [docs/REVIEW-RULES.md](docs/REVIEW-RULES.md) when a review or debugging pass teaches a reusable rule
