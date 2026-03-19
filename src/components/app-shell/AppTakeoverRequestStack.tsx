import { For, type JSX } from 'solid-js';
import type { IncomingTaskTakeoverRequest } from '../../store/types';
import { TaskTakeoverRequestDialog } from '../TaskTakeoverRequestDialog';

interface AppTakeoverRequestStackProps {
  busyRequestIds: ReadonlySet<string>;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onExpire: (requestId: string) => void;
  requests: ReadonlyArray<IncomingTaskTakeoverRequest>;
}

export function AppTakeoverRequestStack(props: AppTakeoverRequestStackProps): JSX.Element {
  return (
    <For each={props.requests}>
      {(request, index) => (
        <TaskTakeoverRequestDialog
          busy={props.busyRequestIds.has(request.requestId)}
          index={index()}
          request={request}
          onApprove={(requestId) => {
            props.onApprove(requestId);
          }}
          onDeny={(requestId) => {
            props.onDeny(requestId);
          }}
          onExpire={(requestId) => {
            props.onExpire(requestId);
          }}
        />
      )}
    </For>
  );
}
