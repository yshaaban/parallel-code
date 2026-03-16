import { produce } from 'solid-js/store';
import {
  isRemovedTaskReviewEvent,
  type TaskReviewEvent,
  type TaskReviewSnapshot,
} from '../domain/task-review';
import { deleteRecordEntry } from '../store/record-utils';
import { setStore, store } from '../store/core';

export function applyTaskReviewEvent(event: TaskReviewEvent): void {
  if (isRemovedTaskReviewEvent(event)) {
    setStore(
      produce((state) => {
        deleteRecordEntry(state.taskReview, event.taskId);
      }),
    );
    return;
  }

  setStore('taskReview', event.taskId, event);
}

export function replaceTaskReviewSnapshots(snapshots: ReadonlyArray<TaskReviewSnapshot>): void {
  setStore(
    produce((state) => {
      state.taskReview = Object.fromEntries(
        snapshots.map((snapshot) => [snapshot.taskId, snapshot]),
      );
    }),
  );
}

export function clearTaskReview(taskId: string): void {
  setStore(
    produce((state) => {
      deleteRecordEntry(state.taskReview, taskId);
    }),
  );
}

export function getTaskReviewSnapshot(taskId: string): TaskReviewSnapshot | undefined {
  return store.taskReview[taskId];
}
