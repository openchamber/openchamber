import { runBackgroundNetworkTask } from '@/lib/background-network';
import { openCodeTrustRefusalDirectory, requestOpenCodeTrust } from '@/lib/opencodeTrust';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const requestSessionProjectRegistration = async (
  sessionId: string,
  directory: string,
  isCurrent: () => boolean,
  deliberate: boolean,
) => {
  const register = () => runBackgroundNetworkTask(() => isCurrent() ? runtimeFetch('/api/projects/session-directory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, directory }),
  }) : Promise.resolve(null));
  const response = await register();
  if (!response) return null;
  const refused = await openCodeTrustRefusalDirectory(response);
  if (!refused) return response;
  if (!isCurrent() || !await requestOpenCodeTrust(refused, { deliberate, background: !deliberate, throwOnError: true })) return null;
  return register();
};
