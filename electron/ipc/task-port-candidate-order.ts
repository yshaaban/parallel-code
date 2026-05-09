import type { TaskPortExposureCandidate } from '../../src/domain/server-state.js';

type TaskPortExposureCandidateOrderSource = TaskPortExposureCandidate['source'];

const TASK_PORT_EXPOSURE_SOURCE_RANK = {
  task: 0,
  local: 1,
} satisfies Record<TaskPortExposureCandidateOrderSource, number>;

export function compareTaskPortExposureCandidateOrder<
  TCandidate extends {
    port: number;
    source: TaskPortExposureCandidateOrderSource;
  },
>(left: TCandidate, right: TCandidate): number {
  const sourceRank =
    TASK_PORT_EXPOSURE_SOURCE_RANK[left.source] - TASK_PORT_EXPOSURE_SOURCE_RANK[right.source];
  if (sourceRank !== 0) {
    return sourceRank;
  }

  return left.port - right.port;
}
