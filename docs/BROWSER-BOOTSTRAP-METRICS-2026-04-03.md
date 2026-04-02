# Browser Bootstrap Metrics 2026-04-03

This note tracks the browser-startup measurement workflow after the cold-bootstrap/reconnect split.

## Goal

Measure cold browser startup separately from reconnect restore and keep the next architecture step
evidence-driven.

## Manual Benchmark Command

Run the manual browser-lab benchmark with:

```bash
RUN_BROWSER_STARTUP_METRICS=1 npm run test:browser:run -- tests/browser/browser-startup-metrics.spec.ts --project chromium --workers=1
```

The benchmark prints a JSON payload with:

- `browserStartup`
  - current mode
  - current tier
  - cold-bootstrap/reconnect start counts
  - cold-bootstrap/reconnect last duration
  - tier entry counts
  - tier last reached timings
- `terminalStartupPaint`
  - selected logical ready
  - selected paint ready
  - visible-sibling and hidden startup counters

## What To Compare

Capture the same experiment:

1. before changing cold bootstrap payload shape
2. after switching cold bootstrap to the backend-owned projection
3. after any selected-terminal attach optimization

## Current Status

- cold bootstrap and reconnect restore are already separated
- the browser-lab benchmark hook is now in
  `tests/browser/browser-startup-metrics.spec.ts`
- cold bootstrap now consumes a typed backend-owned workspace projection instead of
  `workspaceStateJson`
- capture is still manual because this is a diagnostic experiment, not a default CI gate
