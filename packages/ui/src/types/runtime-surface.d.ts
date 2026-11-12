import type { HostedSurface } from '@/lib/runtimeSurface';

declare global {
  interface Window {
    __OPENCHAMBER_SURFACE__?: HostedSurface;
  }
}
