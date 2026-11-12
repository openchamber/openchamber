import { z } from 'zod';
import type { GitManagedSshIntent, GitManagedSshResult } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const unsupported = z.object({ status: z.literal('unsupported'), reason: z.literal('host-setup-required') }).strict();
const fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/);
const credential = z.object({
  credentialId: z.string().regex(/^ocgit:v1:ssh:[A-Za-z0-9_-]{1,267}$/),
  label: z.literal('SSH'),
  fingerprint,
  capability: z.union([
    z.object({ status: z.literal('ready') }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.enum(['unreadable', 'encrypted-or-unverifiable', 'fingerprint-mismatch']) }).strict(),
  ]),
}).strict();
const readyCredential = credential.extend({ capability: z.object({ status: z.literal('ready') }).strict() });
const candidateLabel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const candidate = z.union([
  z.object({
    candidateId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    label: candidateLabel,
    fingerprint,
    capability: z.object({ status: z.literal('ready') }).strict(),
  }).strict(),
  z.object({
    label: candidateLabel,
    capability: z.object({
      status: z.literal('unavailable'),
      reason: z.enum(['unreadable', 'encrypted-or-unverifiable', 'insecure-permissions']),
    }).strict(),
  }).strict(),
]);
const resultSchema = z.union([
  unsupported,
  z.object({
    status: z.literal('available'),
    credentials: z.array(credential).max(256),
  }).strict(),
  z.object({ status: z.literal('discovered'), candidates: z.array(candidate).max(128), truncated: z.boolean() }).strict(),
  z.object({ status: z.literal('imported'), credentials: z.array(credential).max(256), selectedCredential: readyCredential }).strict(),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum(['candidate-expired', 'candidate-changed', 'fingerprint-mismatch', 'candidate-unavailable', 'inventory-full']),
  }).strict(),
]);

export const managedSshCredentials = async (intent: GitManagedSshIntent, fetch = runtimeFetch): Promise<GitManagedSshResult> => {
  const response = await fetch('/api/git/managed-ssh-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent),
  });
  if (!response.ok) throw new Error('Managed SSH inventory request failed');
  const result = resultSchema.parse(await response.json());
  if (result.status === 'imported' && !result.credentials.some((item) => item.credentialId === result.selectedCredential.credentialId
    && item.fingerprint === result.selectedCredential.fingerprint && item.capability.status === 'ready')) {
    throw new Error('Managed SSH import response is inconsistent');
  }
  return result;
};
