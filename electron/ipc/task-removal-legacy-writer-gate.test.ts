import { describe, expect, it, vi } from 'vitest';

import {
  TaskRemovalLegacyWriterDisabledError,
  WorkspaceTaskRemovalLegacyWriterGate,
} from './task-removal-legacy-writer-gate.js';

describe('WorkspaceTaskRemovalLegacyWriterGate', () => {
  it('drains admitted legacy removal before closing the writer', async () => {
    const gate = new WorkspaceTaskRemovalLegacyWriterGate();
    let release!: () => void;
    const effect = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('done');
        }),
    );
    const admitted = gate.runLegacyRemoval(effect);
    await Promise.resolve();

    let disabled = false;
    const cutover = gate.disableLegacyRemovalWriters('epoch-1').then(() => {
      disabled = true;
    });
    await Promise.resolve();
    expect(disabled).toBe(false);

    release();
    await expect(admitted).resolves.toBe('done');
    await cutover;
    await expect(gate.verifyLegacyRemovalWritersDisabled('epoch-1')).resolves.toBeUndefined();
    await expect(gate.runLegacyRemoval(async () => 'late')).rejects.toBeInstanceOf(
      TaskRemovalLegacyWriterDisabledError,
    );
  });

  it('rejects mismatched activation epochs', async () => {
    const gate = new WorkspaceTaskRemovalLegacyWriterGate();
    await gate.disableLegacyRemovalWriters('epoch-1');
    await expect(gate.disableLegacyRemovalWriters('epoch-2')).rejects.toThrow(
      'cutover epoch changed',
    );
  });
});
