import { produce } from 'solid-js/store';
import { setStore } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { isTaskCommandLeaseSkipped, runWithAgentTaskCommandLease } from '../app/task-command-lease';
import type { DiffComment, PermissionRequest, PermissionAutoRule } from './types';

// --- Permission actions ---

export function addPermissionRequest(agentId: string, request: PermissionRequest): void {
  setStore(
    produce((s) => {
      if (!s.permissionRequests[agentId]) {
        s.permissionRequests[agentId] = [];
      }
      s.permissionRequests[agentId].push(request);
    }),
  );
}

export function resolvePermission(
  agentId: string,
  requestId: string,
  action: 'approved' | 'denied',
): void {
  setStore(
    produce((s) => {
      const requests = s.permissionRequests[agentId];
      if (!requests) return;
      const req = requests.find((r) => r.id === requestId);
      if (req) {
        req.status = action;
        req.resolvedAt = Date.now();
      }
    }),
  );
}

export function expirePermissions(agentId: string): void {
  setStore(
    produce((s) => {
      const requests = s.permissionRequests[agentId];
      if (!requests) return;
      for (const req of requests) {
        if (req.status === 'pending') {
          req.status = 'expired';
          req.resolvedAt = Date.now();
        }
      }
    }),
  );
}

export function addPermissionAutoRule(rule: PermissionAutoRule): void {
  setStore(
    produce((s) => {
      s.permissionAutoRules.push(rule);
    }),
  );
}

export async function handlePermissionResponse(
  agentId: string,
  requestId: string,
  action: 'approve' | 'deny',
): Promise<void> {
  const response = action === 'approve' ? 'y\n' : 'n\n';
  const result = await runWithAgentTaskCommandLease(
    agentId,
    `${action} a permission request`,
    async () => {
      await invoke(IPC.WriteToAgent, { agentId, data: response });
    },
  );
  if (isTaskCommandLeaseSkipped(result)) {
    return;
  }
  resolvePermission(agentId, requestId, action === 'approve' ? 'approved' : 'denied');
}

export function clearPermissionRequests(agentId: string): void {
  setStore(
    produce((s) => {
      delete s.permissionRequests[agentId];
    }),
  );
}

// --- Review comment actions ---

export function addReviewComment(taskId: string, comment: DiffComment): void {
  setStore(
    produce((s) => {
      if (!s.reviewComments[taskId]) {
        s.reviewComments[taskId] = [];
      }
      s.reviewComments[taskId].push(comment);
    }),
  );
}

export function updateReviewComment(
  taskId: string,
  commentId: string,
  patch: Partial<Pick<DiffComment, 'text' | 'status'>>,
): void {
  setStore(
    produce((s) => {
      const comments = s.reviewComments[taskId];
      if (!comments) return;
      const comment = comments.find((c) => c.id === commentId);
      if (comment) {
        if (patch.text !== undefined) comment.text = patch.text;
        if (patch.status !== undefined) comment.status = patch.status;
      }
    }),
  );
}

export function removeReviewComment(taskId: string, commentId: string): void {
  setStore(
    produce((s) => {
      const comments = s.reviewComments[taskId];
      if (!comments) return;
      s.reviewComments[taskId] = comments.filter((c) => c.id !== commentId);
    }),
  );
}

export function markCommentsSent(taskId: string, commentIds: string[]): void {
  const now = Date.now();
  setStore(
    produce((s) => {
      const comments = s.reviewComments[taskId];
      if (!comments) return;
      const idSet = new Set(commentIds);
      for (const comment of comments) {
        if (idSet.has(comment.id)) {
          comment.status = 'sent';
          comment.sentAt = now;
        }
      }
    }),
  );
}

export function markCommentsStale(taskId: string, filePath: string): void {
  setStore(
    produce((s) => {
      const comments = s.reviewComments[taskId];
      if (!comments) return;
      for (const comment of comments) {
        if (comment.anchor.filePath === filePath && comment.status === 'draft') {
          comment.status = 'stale';
        }
      }
    }),
  );
}

export function setReviewPanelOpen(taskId: string, open: boolean): void {
  setStore('reviewPanelOpen', taskId, open);
}
