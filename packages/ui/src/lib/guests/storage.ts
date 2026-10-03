import { HostRequestError, type GuestStorageRequest, type GuestStorageResult } from '@openchamber/sdk';
import { guestStorageResultSchema } from '@openchamber/sdk/schemas';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const guestStorageOperation = async (guestId: string, request: GuestStorageRequest): Promise<GuestStorageResult> => {
  const response = await runtimeFetch(`/api/guests/${encodeURIComponent(guestId)}/storage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  if (!response.ok) throw new HostRequestError('HOST_REJECTED', 'Storage operation failed. Check extension approval and storage limits.');
  return guestStorageResultSchema.parse(await response.json());
};
