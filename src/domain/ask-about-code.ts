export interface AskAboutCodeMessage {
  type: 'chunk' | 'done' | 'error';
  text?: string;
  exitCode?: number | null;
}
