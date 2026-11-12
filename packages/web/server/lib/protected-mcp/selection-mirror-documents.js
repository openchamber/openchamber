import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from '../opencode/mcp-local-files.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

export const projectIdentitySchema = z.string().max(4096)
  .regex(/^(?:git|directory):\/[^\x00-\x1f\x7f-\x9f]*$/);
export const mcpNameSchema = z.string().max(64).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/);
const serversSchema = z.record(mcpNameSchema, z.object({
  connection: z.string().regex(/^pmcp_[0-9a-f]{16}$/), disabled: z.boolean().optional(),
}).strict()).refine((servers) => Object.keys(servers).length <= 256);
const documentSchema = z.object({
  version: z.literal(1), identity: projectIdentitySchema.optional(), servers: serversSchema,
}).strict();
const selectionMirrorSchema = z.object({
  version: z.literal(1), documents: z.array(documentSchema).max(1024),
}).strict().superRefine(({ documents }, ctx) => {
  const names = documents.map(selectionDocumentName);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate document' });
});
export const MAX_SELECTION_MIRROR_BYTES = 1024 * 1024;
const managedDocument = (name) => name === 'global.json' || /^project-[0-9a-f]{64}\.json$/.test(name);
const activeDocument = (document) => document.identity === undefined || Object.keys(document.servers).length > 0;

export function selectionDocumentName(document) {
  return document.identity === undefined ? 'global.json'
    : `project-${createHash('sha256').update(document.identity).digest('hex')}.json`;
}

/** Reads owner documents only. Missing storage is a complete empty snapshot. */
export async function readSelectionMirror(dataDir, replacement) {
  const directory = path.join(dataDir, 'mcp-protected');
  let names;
  try { names = await fs.promises.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const documents = [];
  for (const name of names.sort().filter(managedDocument)) {
    if (replacement && name === selectionDocumentName(replacement)) continue;
    const document = documentSchema.parse(JSON.parse(await fs.promises.readFile(path.join(directory, name), 'utf8')));
    if (selectionDocumentName(document) !== name) throw new Error('selection_document_identity_mismatch');
    if (activeDocument(document)) documents.push(document);
  }
  if (replacement && activeDocument(replacement)) documents.push(replacement);
  return selectionMirrorSchema.parse({ version: 1, documents });
}

/** A successful front-door save must fit the agent's complete-snapshot contract. */
export async function assertSelectionMirrorWriteFits(dataDir, replacement) {
  try {
    const snapshot = await readSelectionMirror(dataDir, replacement);
    if (Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SELECTION_MIRROR_BYTES) return;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
  }
  const error = new Error('Protected MCP selection capacity exceeded');
  error.code = 'PROTECTED_SELECTION_CAPACITY';
  throw error;
}

/** Replaces each file atomically in the existing watched directory, then removes stale files. */
export async function replaceSelectionMirror(dataDir, input) {
  const snapshot = selectionMirrorSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SELECTION_MIRROR_BYTES) throw new Error('selection_mirror_too_large');
  const directory = path.join(dataDir, 'mcp-protected');
  await ensureLocalMcpDirectory(directory);
  return withSourceControlFileLock(path.join(dataDir, 'mcp-protected-mirror.lock'), async () => {
    const retained = new Set(snapshot.documents.map(selectionDocumentName));
    for (const document of snapshot.documents) {
      await writeLocalMcpFile(path.join(directory, selectionDocumentName(document)), `${JSON.stringify(document, null, 2)}\n`);
    }
    for (const name of (await fs.promises.readdir(directory)).filter(managedDocument)) {
      if (!retained.has(name)) await fs.promises.rm(path.join(directory, name), { force: true });
    }
  });
}
