import { describe, expect, it } from 'vitest';
import { createOutboundChannelLanes } from './browser-outbound-lanes.js';

describe('createOutboundChannelLanes', () => {
  it('orders focused channels ahead of background channels for drain passes', () => {
    const lanes = createOutboundChannelLanes();
    lanes.setFocusedChannelIds(['focused-1']);

    const ordered = lanes.orderChannelsForDrain(['background-a', 'focused-1', 'background-b']);

    expect(ordered[0]).toBe('focused-1');
    expect(ordered.slice(1).sort()).toEqual(['background-a', 'background-b']);
  });

  it('rotates the background start position across drain passes for fairness', () => {
    const lanes = createOutboundChannelLanes();
    const channels = ['bg-a', 'bg-b', 'bg-c'];

    const firstPassLeader = lanes.orderChannelsForDrain(channels)[0];
    const secondPassLeader = lanes.orderChannelsForDrain(channels)[0];

    expect(firstPassLeader).not.toBe(secondPassLeader);
    expect(lanes.orderChannelsForDrain(channels)).toHaveLength(3);
  });

  it('keeps focused channels exempt from the background byte budget', () => {
    const lanes = createOutboundChannelLanes({ backgroundByteBudgetPerPass: 1024 });
    lanes.setFocusedChannelIds(['focused-1']);

    expect(lanes.isFocusedChannel('focused-1')).toBe(true);
    expect(lanes.isFocusedChannel('background-a')).toBe(false);
    expect(lanes.getBackgroundByteBudgetPerPass()).toBe(1024);
  });

  it('defers background bulk sends above the bufferedAmount soft cap but never focused ones', () => {
    const lanes = createOutboundChannelLanes({ bulkBufferedAmountSoftCapBytes: 256 * 1024 });
    lanes.setFocusedChannelIds(['focused-1']);

    expect(lanes.shouldDeferBulkSend('background-a', 256 * 1024 + 1)).toBe(true);
    expect(lanes.shouldDeferBulkSend('background-a', 64 * 1024)).toBe(false);
    expect(lanes.shouldDeferBulkSend('focused-1', 10 * 1024 * 1024)).toBe(false);
  });

  it('replaces the focused set atomically on focus changes', () => {
    const lanes = createOutboundChannelLanes();
    lanes.setFocusedChannelIds(['focused-1', 'focused-2']);
    lanes.setFocusedChannelIds(['focused-3']);

    expect(lanes.isFocusedChannel('focused-1')).toBe(false);
    expect(lanes.isFocusedChannel('focused-2')).toBe(false);
    expect(lanes.isFocusedChannel('focused-3')).toBe(true);
  });
});
