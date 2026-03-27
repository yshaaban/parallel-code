import { describe, expect, it } from 'vitest';

import {
  formatTerminalDiagnosticsSnapshot,
  listTerminalAnomalies,
} from '../browser/harness/terminal-render.js';

describe('listTerminalAnomalies', () => {
  it('reports a missing browser-side anomaly monitor snapshot', () => {
    expect(listTerminalAnomalies(null)).toEqual(['terminal-anomaly-monitor:missing']);
  });

  it('returns no findings for a clean monitor snapshot', () => {
    expect(
      listTerminalAnomalies({
        capturedAtMs: 0,
        outputSummary: {} as never,
        recentEvents: [],
        rendererRuntime: {} as never,
        summary: {
          anomalyCounts: {
            'focused-ready-without-live-render': 0,
            'peer-controlled-cursor': 0,
            'prolonged-loading': 0,
            'terminal-error': 0,
            'visible-dormant': 0,
            'visible-render-hibernating': 0,
            'visible-restore-blocked': 0,
          },
          terminalsTracked: 1,
          terminalsWithAnomalies: 0,
          totalAnomalies: 0,
        },
        terminals: [
          {
            agentId: 'agent-1',
            anomalies: [],
            counters: {
              blockedInputAttempts: 0,
              readOnlyInputAttempts: 0,
              statusTransitions: 1,
            },
            key: 'task-1:agent-1',
            lifecycle: {
              cursorBlink: true,
              hasPeerController: false,
              isFocused: true,
              isSelected: true,
              isVisible: true,
              liveRenderReady: true,
              presentationMode: 'live',
              renderHibernating: false,
              restoreBlocked: false,
              sessionDormant: false,
              status: 'ready',
              surfaceTier: 'interactive-live',
              updatedAtMs: 0,
            },
            recentEvents: [],
            taskId: 'task-1',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('lists generic anomaly findings without depending on a specific agent implementation', () => {
    expect(
      listTerminalAnomalies({
        capturedAtMs: 0,
        outputSummary: {} as never,
        recentEvents: [],
        rendererRuntime: {} as never,
        summary: {
          anomalyCounts: {
            'focused-ready-without-live-render': 0,
            'peer-controlled-cursor': 0,
            'prolonged-loading': 1,
            'terminal-error': 0,
            'visible-dormant': 0,
            'visible-render-hibernating': 0,
            'visible-restore-blocked': 0,
          },
          terminalsTracked: 2,
          terminalsWithAnomalies: 1,
          totalAnomalies: 1,
        },
        terminals: [
          {
            agentId: 'agent-a',
            anomalies: [
              {
                activeSinceMs: 10,
                durationMs: 5_200,
                key: 'prolonged-loading',
                label: 'Loading taking too long',
                severity: 'warning',
                thresholdMs: 4_000,
              },
            ],
            counters: {
              blockedInputAttempts: 0,
              readOnlyInputAttempts: 0,
              statusTransitions: 2,
            },
            key: 'task-a:agent-a',
            lifecycle: {
              cursorBlink: false,
              hasPeerController: false,
              isFocused: false,
              isSelected: true,
              isVisible: true,
              liveRenderReady: false,
              presentationMode: 'loading',
              renderHibernating: false,
              restoreBlocked: false,
              sessionDormant: false,
              status: 'attaching',
              surfaceTier: 'passive-visible',
              updatedAtMs: 0,
            },
            recentEvents: [],
            taskId: 'task-a',
          },
          {
            agentId: 'agent-b',
            anomalies: [],
            counters: {
              blockedInputAttempts: 0,
              readOnlyInputAttempts: 0,
              statusTransitions: 1,
            },
            key: 'task-b:agent-b',
            lifecycle: {
              cursorBlink: true,
              hasPeerController: false,
              isFocused: true,
              isSelected: true,
              isVisible: true,
              liveRenderReady: true,
              presentationMode: 'live',
              renderHibernating: false,
              restoreBlocked: false,
              sessionDormant: false,
              status: 'ready',
              surfaceTier: 'interactive-live',
              updatedAtMs: 0,
            },
            recentEvents: [],
            taskId: 'task-b',
          },
        ],
      }),
    ).toEqual([
      'summary-total-anomalies:1',
      'summary-terminals-with-anomalies:1',
      'agent-a:prolonged-loading:warning',
    ]);
  });

  it('serializes a composite terminal diagnostics bundle without losing live capture fields', () => {
    const snapshot = {
      browserLifecycleSnapshot: {
        page: {
          banner: [{ atMs: 2, message: 'ready', state: 'ready' }],
          events: [{ atMs: 1, detail: 'visible', kind: 'pageshow', source: 'window' as const }],
        },
        server: {
          exitCode: null,
          exitObserved: false,
          exitedAtMs: null,
          pid: 1234,
          signalCode: null,
          startedAtMs: 0,
          stderrTail: '',
          stdoutTail: '',
          unexpectedExit: false,
        },
      },
      pageDiagnostics: {
        anomalySnapshot: null,
        capturedAtMs: 3,
        outputDiagnostics: null,
        pageLifecycle: {
          banner: [{ atMs: 2, message: 'ready', state: 'ready' }],
          events: [{ atMs: 1, detail: 'visible', kind: 'pageshow', source: 'window' as const }],
        },
        rendererDiagnostics: null,
        terminalSnapshots: [],
      },
    };

    const json = formatTerminalDiagnosticsSnapshot(snapshot);

    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(snapshot);
  });
});
