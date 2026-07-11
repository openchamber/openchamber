/**
 * Session status bootstrap is now handled by the sync system's own bootstrap
 * (sync/bootstrap.ts). This hook is retained as a no-op for call-site compat.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const useSessionStatusBootstrap = (_options?: { enabled?: boolean }) => {
  // no-op — session_status is bootstrapped by sync child stores
};
