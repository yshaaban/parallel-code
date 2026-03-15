import { describe, expect, it } from 'vitest';
import { detectObservedPortsFromOutput } from './port-detection.js';

describe('port detection', () => {
  it('strips terminal escape noise from detected URL suggestions', () => {
    const detections = detectObservedPortsFromOutput(
      `localhost:9090/webhook/health\u001b[79C\u001b[38;2;72;150;140m│`,
    );

    expect(detections).toEqual([
      {
        host: 'localhost',
        port: 9090,
        protocol: 'http',
        suggestion: 'localhost:9090/webhook/health',
      },
    ]);
  });

  it('trims trailing non-url glyphs from detected URL suggestions', () => {
    const detections = detectObservedPortsFromOutput(
      'localhost:9090/webhook/health[79C[38;2;72;150;140m│',
    );

    expect(detections).toEqual([
      {
        host: 'localhost',
        port: 9090,
        protocol: 'http',
        suggestion: 'localhost:9090/webhook/health',
      },
    ]);
  });

  it('does not trim legitimate lowercase bracket suffixes from detected URLs', () => {
    const detections = detectObservedPortsFromOutput('localhost:9090/webhook/health[123a');

    expect(detections).toEqual([
      {
        host: 'localhost',
        port: 9090,
        protocol: 'http',
        suggestion: 'localhost:9090/webhook/health[123a',
      },
    ]);
  });

  it('drops shell redirection fragments from detected URL suggestions', () => {
    const detections = detectObservedPortsFromOutput('localhost:8888/2>&1)');

    expect(detections).toEqual([
      {
        host: 'localhost',
        port: 8888,
        protocol: 'http',
        suggestion: 'localhost:8888',
      },
    ]);
  });

  it('drops shell command fragments from detected webhook suggestions', () => {
    const detections = detectObservedPortsFromOutput(
      `localhost:9090/webhook/<token>-H'Content-Type:application/json'-d'{"event":"test"}'`,
    );

    expect(detections).toEqual([
      {
        host: 'localhost',
        port: 9090,
        protocol: 'http',
        suggestion: 'localhost:9090/webhook',
      },
    ]);
  });

  it('preserves ampersands inside legitimate URL paths', () => {
    const detections = detectObservedPortsFromOutput('localhost:7777/foo&bar');

    expect(detections).toEqual([
      {
        host: 'localhost',
        port: 7777,
        protocol: 'http',
        suggestion: 'localhost:7777/foo&bar',
      },
    ]);
  });

  it('normalizes generic listening matches to a compact port label', () => {
    const detections = detectObservedPortsFromOutput('servers: Port 3001');

    expect(detections).toEqual([
      {
        host: null,
        port: 3001,
        protocol: 'http',
        suggestion: 'Port 3001',
      },
    ]);
  });
});
