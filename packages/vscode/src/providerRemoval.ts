import { z } from 'zod';
import { removeProviderConfig } from './opencodeConfig';

export const providerRemovePayloadSchema = z.object({
  providerId: z.string().min(1),
  directory: z.string().optional(),
});

export const removeProviderFromAllLayers = (providerId: string, workingDirectory?: string) => {
  let removed = false;
  while (removeProviderConfig(providerId, workingDirectory, 'user')) removed = true;
  if (workingDirectory && removeProviderConfig(providerId, workingDirectory, 'project')) removed = true;
  if (removeProviderConfig(providerId, workingDirectory, 'custom')) removed = true;
  return removed;
};
