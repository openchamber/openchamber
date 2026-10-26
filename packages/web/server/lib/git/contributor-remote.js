// Shared by change-request source construction and the contributor transfer
// pipeline, which derives the owner again from the provider's current answer.
export const forkRemoteName = (owner) => `pr-${String(owner || '').trim().toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'head'}`;
