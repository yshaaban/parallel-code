import type {
  GetTaskNotesRequest,
  GetTaskNotesResult,
  IssueTaskNotesOperationRequest,
  IssueTaskNotesOperationResult,
  TaskNotesWireResponse,
  UpdateTaskNotesRequest,
  UpdateTaskNotesResult,
} from '../../domain/task-notes';

export interface TaskNotesTransport {
  get(
    request: GetTaskNotesRequest,
    signal: AbortSignal,
  ): Promise<TaskNotesWireResponse<GetTaskNotesResult>>;
  issue(
    request: IssueTaskNotesOperationRequest,
  ): Promise<TaskNotesWireResponse<IssueTaskNotesOperationResult>>;
  update(request: UpdateTaskNotesRequest): Promise<TaskNotesWireResponse<UpdateTaskNotesResult>>;
}
