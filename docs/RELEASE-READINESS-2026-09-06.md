# Release-readiness review — 2026-09-06

## Decision

The corrective series following `4851acae` is reviewed and locally validated, but is **not yet
cleared for production release**. Pushing this series does not waive resource budgets or establish
container, cross-platform, or signed-distribution readiness.

Last-minute parallel reviews found no additional important correctness or integration issues in
the frozen Git/security, lifecycle/persistence/lease, and frontend changes. The 145 implementation,
test, configuration, and contract-document files matched the locally validated package workspace
byte-for-byte before commit preparation. This status note was added afterward.
The final pre-commit rerun also passed 97 focused backend/lease/Git tests and 71 focused Solid
tests. Their logs are `tmp/precommit-owner-review-2026-09-06.log` and
`tmp/precommit-ui-review-2026-09-06.log`.

## Completed local proof

Validation used Node 24.19.0, npm 11.17.0, Darwin 25.4.0, and Apple M5 arm64.

| Check                                               | Result                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Type checks, lint, formatting, architecture guards  | Pass, including 118 architecture tests                                                  |
| Full `npm test`                                     | 6,140 passed; 7 explicitly opt-in tests skipped                                         |
| Validation guards                                   | 149 passed                                                                              |
| Active-feature browser acceptance                   | 45 passed, no retries or skips                                                          |
| Dedicated terminal acceptance                       | 42 passed                                                                               |
| Manual startup fixture, baseline one-shell scenario | 1 passed                                                                                |
| Clean install and unsigned full-release capture     | 3 samples passed; each archive verified                                                 |
| Packaged native terminal smoke                      | Real shell through the candidate archive's `node-pty` passed                            |
| Dependency exposure audit                           | No shipped backend/renderer advisories; 2 moderate tooling advisories allowed by policy |
| Dependency tree                                     | `npm ls --all` passed                                                                   |

The full test total comprises 4,995 default Node, 44 serial performance, 7 benchmark,
55 server integration, 32 coordinator end-to-end, and 1,007 Solid tests. Browser proof includes
parallel root tasks on custom branches, sibling continuity, repeated collapse/reopen, terminal
restore/focus, merge recovery, and remote task-creation retry behavior.

## Outstanding release gates

Fresh three-sample resource capture completed on 2026-09-05 at 20:34:08 UTC. Comparison validated
the same machine, toolchain, protocol, artifact set, and current dependency-input hashes. Four
measurements failed the unchanged historical growth limits:

| Measurement                | Historical median | Candidate median | Growth | Limit |
| -------------------------- | ----------------: | ---------------: | -----: | ----: |
| Remote eager entry, raw    |         491,284 B |        580,233 B | 18.11% |    2% |
| Remote eager entry, gzip   |         132,726 B |        157,325 B | 18.53% |    2% |
| Remote eager entry, Brotli |         113,047 B |        133,823 B | 18.38% |    2% |
| Application archive        |      57,034,223 B |     59,706,898 B |  4.69% |    3% |

All other comparison checks passed. Current integrated feature-bundle gates also passed, but
do not waive these historical resource gates. No dependency changes were made in this corrective
series. The historical baseline predates later eager feature integration; it does not isolate
the byte cost of these fixes. No budget was raised and no baseline was replaced.

Before production release:

- Reduce remote-entry and application-archive footprint, then recapture against the same baseline.
- Obtain passing cross-platform/minimum-Node CI and container execution evidence. Docker was not
  available locally; a reviewed Dockerfile is not an executed container test.
- Complete signing/notarization validation for a signed desktop distribution. Local packages
  were deliberately unsigned and built with `--publish never`.

Notes remains default-dark; these checks do not authorize its promotion. Operational migration
and recovery guidance lives in [README](../README.md#troubleshooting--local-setup-notes), listener
security in [PRIVACY](../PRIVACY.md), and validation policy in [TESTING](./TESTING.md).

## Local evidence locations

Detailed evidence is retained locally, not committed: `tmp/production-readiness-fixes-2026-09-05.md`,
`tmp/production-complete-*.log`, `tmp/production-complete-browser.json`,
`tmp/production-package-capture.log`, `tmp/production-packaged-pty-smoke.log`,
`tmp/production-package-audit.log`, `tmp/production-package-tree.log`,
`tmp/dependency-resource-target.json`, and `tmp/production-resource-comparison.log`.
Earlier failures and diagnostic traces remain in that local report; they are not counted as
passing final acceptance. CI outcomes must be checked on the pushed revision separately.
