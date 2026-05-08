export type AskAboutCodeProviderId = 'claude' | 'minimax';

export interface AskAboutCodeMessage {
  type: 'chunk' | 'done' | 'error';
  text?: string;
  exitCode?: number | null;
}

export function isAskAboutCodeProviderId(value: string): value is AskAboutCodeProviderId {
  return value === 'claude' || value === 'minimax';
}
