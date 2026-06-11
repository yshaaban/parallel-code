// Outbound wire-priority lanes for the browser channel plane.
//
// Lane invariant (shared with the delta-resync item): lane 0 is ALL sequenced
// control-plane traffic — live broadcasts, per-event replay, batch-replay
// frames, and bootstrap messages. That lane stays on the existing strict-FIFO
// control send path (browser-send-queue + browser-control-delayed-sends) and
// is NEVER reordered by this module, so the sequenced replay contract is
// untouched. Only bulk channel data frames ride the lower lanes:
//   lane 1: focused-channel frames (priority derived from
//           ReportClientTaskFocus.focusedChannelIds via the control-plane
//           consumer; never from a second renderer focus owner)
//   lane 2: background channels, drained round-robin with a per-pass byte
//           budget and a bufferedAmount soft cap for bulk sends.

const DEFAULT_BACKGROUND_CHANNEL_BYTE_BUDGET_PER_PASS = 32 * 1024;
const DEFAULT_BULK_BUFFERED_AMOUNT_SOFT_CAP = 256 * 1024;

export interface OutboundChannelLanes {
  getBackgroundByteBudgetPerPass: () => number;
  isFocusedChannel: (channelId: string) => boolean;
  orderChannelsForDrain: (channelIds: Iterable<string>) => string[];
  setFocusedChannelIds: (channelIds: Iterable<string>) => void;
  shouldDeferBulkSend: (channelId: string, bufferedAmountBytes: number) => boolean;
}

export interface CreateOutboundChannelLanesOptions {
  backgroundByteBudgetPerPass?: number;
  bulkBufferedAmountSoftCapBytes?: number;
}

export function createOutboundChannelLanes(
  options: CreateOutboundChannelLanesOptions = {},
): OutboundChannelLanes {
  const backgroundByteBudgetPerPass =
    options.backgroundByteBudgetPerPass ?? DEFAULT_BACKGROUND_CHANNEL_BYTE_BUDGET_PER_PASS;
  const bulkBufferedAmountSoftCapBytes =
    options.bulkBufferedAmountSoftCapBytes ?? DEFAULT_BULK_BUFFERED_AMOUNT_SOFT_CAP;
  let focusedChannelIds: ReadonlySet<string> = new Set();
  // Rotates the background start index so one noisy channel cannot
  // monopolize every drain pass.
  let backgroundRotation = 0;

  function isFocusedChannel(channelId: string): boolean {
    return focusedChannelIds.has(channelId);
  }

  function orderChannelsForDrain(channelIds: Iterable<string>): string[] {
    const focused: string[] = [];
    const background: string[] = [];
    for (const channelId of channelIds) {
      if (isFocusedChannel(channelId)) {
        focused.push(channelId);
      } else {
        background.push(channelId);
      }
    }

    if (background.length > 1) {
      const startIndex = backgroundRotation % background.length;
      backgroundRotation += 1;
      return [...focused, ...background.slice(startIndex), ...background.slice(0, startIndex)];
    }

    return [...focused, ...background];
  }

  return {
    getBackgroundByteBudgetPerPass: () => backgroundByteBudgetPerPass,
    isFocusedChannel,
    orderChannelsForDrain,
    setFocusedChannelIds: (channelIds: Iterable<string>) => {
      focusedChannelIds = new Set(channelIds);
    },
    shouldDeferBulkSend: (channelId: string, bufferedAmountBytes: number) => {
      if (isFocusedChannel(channelId)) {
        return false;
      }

      return bufferedAmountBytes > bulkBufferedAmountSoftCapBytes;
    },
  };
}
