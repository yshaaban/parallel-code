import { BadRequestError } from './errors.js';

export function getOptionalChannelId(
  value: unknown,
  label = 'onOutput.__CHANNEL_ID__',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const channel = value as { __CHANNEL_ID__?: unknown } | null;
  if (typeof channel?.__CHANNEL_ID__ !== 'string') {
    throw new BadRequestError(`${label} must be a string`);
  }

  return channel.__CHANNEL_ID__;
}

export function getRequiredChannelId(value: unknown, label?: string): string {
  const channelId = getOptionalChannelId(value, label);
  if (channelId === undefined) {
    throw new BadRequestError(`${label ?? 'onOutput.__CHANNEL_ID__'} must be a string`);
  }

  return channelId;
}
