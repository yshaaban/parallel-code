import { Channel } from '../lib/ipc';

export interface ChannelBinding<Message> {
  channel?: Channel<Message>;
  cleanup: () => void;
}

export interface RequiredChannelBinding<Message> {
  channel: Channel<Message>;
  cleanup: () => void;
}

export type PushOutputBinding = ChannelBinding<string>;

export function createTaskOutputChannelBinding<Message>(
  onMessage: (message: Message) => void,
): RequiredChannelBinding<Message>;
export function createTaskOutputChannelBinding<Message>(
  onMessage?: (message: Message) => void,
): ChannelBinding<Message> {
  if (!onMessage) {
    return { cleanup: () => {} };
  }

  const channel = new Channel<Message>();
  channel.onmessage = onMessage;

  return {
    channel,
    cleanup: () => {
      channel.dispose();
    },
  };
}

export function createPushOutputBinding(onOutput?: (text: string) => void): PushOutputBinding {
  if (!onOutput) {
    return { cleanup: () => {} };
  }

  return createTaskOutputChannelBinding(onOutput);
}
