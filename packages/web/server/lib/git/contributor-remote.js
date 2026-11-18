export const forkRemoteName = (owner) => `pr-${String(owner || '').trim().toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'head'}`;
