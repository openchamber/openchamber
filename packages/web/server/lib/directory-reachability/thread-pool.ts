import fs from 'node:fs';

const POOL_SIZE = '32';

export const widenThreadPool = () => {
  if (process.env.UV_THREADPOOL_SIZE) return;
  process.env.UV_THREADPOOL_SIZE = POOL_SIZE;
  fs.stat(process.execPath, () => { delete process.env.UV_THREADPOOL_SIZE; });
};
