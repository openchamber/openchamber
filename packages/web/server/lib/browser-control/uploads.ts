import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { BrowserControlApp } from './http-contracts.js';

export interface UploadFile {
  name: string;
  path: string;
  size: number;
  bytes: Buffer;
}

export interface UploadTicket {
  token: string;
  files: { name: string; size: number }[];
}

const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_TOKEN_TTL_MS = 2 * 60 * 1000;

export class UploadRefusedError extends Error {}

const uploadPathsSchema = z.array(z.string().trim().min(1)).min(1);

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const realRoot = async (folder: string) => {
  try {
    return await fsp.realpath(folder);
  } catch {
    return null;
  }
};

export const resolveUploadFiles = async ({ paths, directory, tempDirectory = path.join(os.tmpdir(), 'opencode') }: {
  paths: unknown;
  directory: string | null;
  tempDirectory?: string;
}) => {
  const parsedPaths = uploadPathsSchema.safeParse(paths);
  if (!parsedPaths.success) throw new UploadRefusedError('paths is required: the files to upload, each a non-empty string');
  if (parsedPaths.data.length > MAX_UPLOAD_FILES) throw new UploadRefusedError(`At most ${MAX_UPLOAD_FILES} files go in one upload`);
  if (!directory) throw new UploadRefusedError('An upload needs the session folder to read files from');
  const roots = (await Promise.all([realRoot(directory), realRoot(tempDirectory)])).filter((root): root is string => Boolean(root));

  const files: UploadFile[] = [];
  let total = 0;
  for (const raw of parsedPaths.data) {
    const requested = path.resolve(directory, raw.trim());
    let real;
    try {
      real = await fsp.realpath(requested);
    } catch {
      throw new UploadRefusedError(`${raw} does not exist`);
    }
    if (!roots.some((root) => isInside(root, real))) {
      throw new UploadRefusedError(`${raw} is outside this session's folder and ${tempDirectory}; only files there can be uploaded`);
    }
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new UploadRefusedError(`${raw} is not a file`);
    if (total + stat.size > MAX_UPLOAD_BYTES) throw new UploadRefusedError('The files are larger than an upload may be (25 MB together)');
    const bytes = await fsp.readFile(real);
    total += bytes.length;
    if (total > MAX_UPLOAD_BYTES) throw new UploadRefusedError('The files are larger than an upload may be (25 MB together)');
    files.push({ name: path.basename(real), path: real, size: bytes.length, bytes });
  }
  return files;
};

export const createUploadStore = ({ now = () => Date.now() }: { now?: () => number } = {}) => {
  const uploads = new Map<string, { files: UploadFile[]; expiresAt: number }>();

  const prune = () => {
    const current = now();
    for (const [token, entry] of uploads) {
      if (entry.expiresAt <= current) uploads.delete(token);
    }
  };

  return {
    put(files: UploadFile[]): UploadTicket {
      prune();
      const token = crypto.randomBytes(24).toString('base64url');
      uploads.set(token, { files, expiresAt: now() + UPLOAD_TOKEN_TTL_MS });
      return { token, files: files.map(({ name, size }) => ({ name, size })) };
    },
    get(token: string, index: number) {
      prune();
      const entry = uploads.get(token);
      if (!entry || !Number.isInteger(index) || index < 0) return null;
      return entry.files[index] ?? null;
    },
  };
};

export const registerUploadRoute = (app: Pick<BrowserControlApp, 'get'>, { store }: { store: ReturnType<typeof createUploadStore> }) => {
  app.get('/api/browser-control/uploads/:token/:index', (req, res) => {
    const file = store.get(String(req.params.token || ''), Number(req.params.index));
    if (!file) {
      res.status(404).json({ error: 'No such upload, or it expired' });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.bytes);
  });
};
