import { produce } from 'solid-js/store';
import { setStore } from './core';
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
      const request = requests.find((currentRequest) => currentRequest.id === requestId);
      if (request) {
        request.status = action;
        request.resolvedAt = Date.now();
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
      const comment = comments.find((currentComment) => currentComment.id === commentId);
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
      s.reviewComments[taskId] = comments.filter(
        (currentComment) => currentComment.id !== commentId,
      );
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
