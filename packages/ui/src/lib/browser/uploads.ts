import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

export const uploadTicketSchema = z.object({
  token: z.string().min(1),
  files: z.array(z.object({ name: z.string().min(1), size: z.number() })).min(1),
});

export type UploadTicket = z.infer<typeof uploadTicketSchema>;

type StagedFile = { name: string; base64: string };

const toBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result ?? '');
    resolve(url.slice(url.indexOf(',') + 1));
  };
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
  reader.readAsDataURL(blob);
});

export const stageBrowserUpload = async (
  ticket: UploadTicket,
  stage: (files: StagedFile[]) => Promise<string[]>,
): Promise<string[]> => {
  const staged: StagedFile[] = [];
  for (const [index, file] of ticket.files.entries()) {
    const response = await runtimeFetch(`/api/browser-control/uploads/${encodeURIComponent(ticket.token)}/${index}`);
    if (!response.ok) throw new Error(`Could not fetch ${file.name} for the upload (HTTP ${response.status})`);
    staged.push({ name: file.name, base64: await toBase64(await response.blob()) });
  }
  return stage(staged);
};
