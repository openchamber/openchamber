import { HostRequestError, type GuestStorageRequest, type GuestStorageResult } from '@openchamber/sdk';
import { guestStorageResultSchema } from '@openchamber/sdk/schemas';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { runDeviceGuestStorage } from './device-storage';

type DeviceStorageAccess = { runtimeKey: string; storageId: string; authorize: () => boolean };

export const guestStorageOperation = async (guestId: string, request: GuestStorageRequest, device?: DeviceStorageAccess): Promise<GuestStorageResult> => {
  if (request.scope === 'device') {
    if (!device || !globalThis.indexedDB) throw new HostRequestError('UNSUPPORTED', 'Device storage is unavailable for this installation.');
    return runDeviceGuestStorage({ runtimeKey: device.runtimeKey, guestId, storageId: device.storageId }, request, device.authorize);
  }
  // Keep the existing instance-storage wire shape for older connected servers.
  const payload = { ...request };
  delete payload.scope;
  const response = await runtimeFetch(`/api/guests/${encodeURIComponent(guestId)}/storage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new HostRequestError('HOST_REJECTED', 'Storage operation failed. Check extension approval and storage limits.');
  return guestStorageResultSchema.parse(await response.json());
};
