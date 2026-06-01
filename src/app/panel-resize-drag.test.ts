import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginPanelResizeDrag,
  endPanelResizeDrag,
  getPanelResizeDragEpoch,
  isPanelResizeDragging,
  resetPanelResizeDragging,
} from './panel-resize-drag';

describe('panel resize drag state', () => {
  beforeEach(() => {
    resetPanelResizeDragging();
  });

  it('advances the drag epoch once when the final active panel drag ends', () => {
    expect(getPanelResizeDragEpoch()).toBe(0);

    beginPanelResizeDrag();
    beginPanelResizeDrag();
    expect(isPanelResizeDragging()).toBe(true);

    endPanelResizeDrag();
    expect(getPanelResizeDragEpoch()).toBe(0);
    expect(isPanelResizeDragging()).toBe(true);

    endPanelResizeDrag();
    expect(getPanelResizeDragEpoch()).toBe(1);
    expect(isPanelResizeDragging()).toBe(false);

    endPanelResizeDrag();
    expect(getPanelResizeDragEpoch()).toBe(1);
  });

  it('resets the active drag count and epoch for test isolation', () => {
    beginPanelResizeDrag();
    endPanelResizeDrag();
    expect(getPanelResizeDragEpoch()).toBe(1);

    resetPanelResizeDragging();

    expect(getPanelResizeDragEpoch()).toBe(0);
    expect(isPanelResizeDragging()).toBe(false);
  });
});
