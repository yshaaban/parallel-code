export interface AsyncRequestToken {
  requestId: number;
  revisionId: string;
}

export interface AsyncRequestGuard {
  beginRequest: () => AsyncRequestToken;
  isCurrent: (token: AsyncRequestToken) => boolean;
  isLatestRequest: (token: AsyncRequestToken) => boolean;
}

export function createAsyncRequestGuard(getRevisionId: () => string): AsyncRequestGuard {
  let latestRequestId = 0;

  return {
    beginRequest(): AsyncRequestToken {
      latestRequestId += 1;
      return {
        requestId: latestRequestId,
        revisionId: getRevisionId(),
      };
    },
    isCurrent(token: AsyncRequestToken): boolean {
      return token.requestId === latestRequestId && token.revisionId === getRevisionId();
    },
    isLatestRequest(token: AsyncRequestToken): boolean {
      return token.requestId === latestRequestId;
    },
  };
}
