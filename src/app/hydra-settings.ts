import { loadAgents } from './agent-catalog';
import { setHydraCommandState } from '../store/ui';

export function setHydraCommand(command: string): void {
  setHydraCommandState(command);
  void loadAgents();
}
