import { createRandomId } from '../lib/random-id';

interface RemoteTerminalOrderState {
  epoch: string;
  nextSeq: number;
}

export interface RemoteTerminalOrderToken {
  epoch: string;
  seq: number;
}

const inputOrderByAgentId = new Map<string, RemoteTerminalOrderState>();
const resizeOrderByAgentId = new Map<string, RemoteTerminalOrderState>();

function nextRemoteTerminalOrder(
  ordersByAgentId: Map<string, RemoteTerminalOrderState>,
  agentId: string,
): RemoteTerminalOrderToken {
  let order = ordersByAgentId.get(agentId);
  if (!order) {
    order = {
      epoch: createRandomId(),
      nextSeq: 0,
    };
    ordersByAgentId.set(agentId, order);
  }

  const seq = order.nextSeq;
  order.nextSeq += 1;
  return {
    epoch: order.epoch,
    seq,
  };
}

function rotateRemoteTerminalOrder(
  ordersByAgentId: Map<string, RemoteTerminalOrderState>,
  agentId: string,
): void {
  ordersByAgentId.set(agentId, {
    epoch: createRandomId(),
    nextSeq: 0,
  });
}

export function nextRemoteInputOrder(agentId: string): RemoteTerminalOrderToken {
  return nextRemoteTerminalOrder(inputOrderByAgentId, agentId);
}

export function nextRemoteResizeOrder(agentId: string): RemoteTerminalOrderToken {
  return nextRemoteTerminalOrder(resizeOrderByAgentId, agentId);
}

export function rotateRemoteInputOrder(agentId: string): void {
  rotateRemoteTerminalOrder(inputOrderByAgentId, agentId);
}

export function rotateRemoteResizeOrder(agentId: string): void {
  rotateRemoteTerminalOrder(resizeOrderByAgentId, agentId);
}

export function resetRemoteTerminalOrderForAgent(agentId: string): void {
  inputOrderByAgentId.delete(agentId);
  resizeOrderByAgentId.delete(agentId);
}

export function resetRemoteTerminalOrderForAllAgents(): void {
  inputOrderByAgentId.clear();
  resizeOrderByAgentId.clear();
}

export const resetRemoteTerminalOrderForTests = resetRemoteTerminalOrderForAllAgents;
