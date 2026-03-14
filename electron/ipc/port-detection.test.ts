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
});
