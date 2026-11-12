import type { GuestRequest, GuestRequestResult, IntegrationAuth } from '@openchamber/sdk';

import { runtimeFetch } from '@/lib/runtime-fetch';

const HOST_LINEAR_ISSUE_GET_PATH = '/api/linear/issues/get';

export const isHostLinearIssueGet = (
  auth: IntegrationAuth | undefined,
  request: Pick<GuestRequest, 'method' | 'path'>,
): boolean => (
  auth === 'host'
  && request.method === 'GET'
  && request.path === HOST_LINEAR_ISSUE_GET_PATH
);

/** First-party Linear get. Guest proxy stays off this path. */
export const fetchHostLinearIssueGet = async (
  auth: IntegrationAuth | undefined,
  request: GuestRequest,
): Promise<GuestRequestResult | null | undefined> => {
  if (!isHostLinearIssueGet(auth, request)) {
    return undefined;
  }
  try {
    const response = await runtimeFetch(HOST_LINEAR_ISSUE_GET_PATH, {
      query: request.query,
    });
    return {
      status: response.status,
      body: await response.text(),
    };
  } catch {
    return null;
  }
};
