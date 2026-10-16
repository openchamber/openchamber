import App from './App.tsx';
import { SessionAuthGate } from './components/auth/SessionAuthGate';
import { useDesktopProjectOpen } from './hooks/useDesktopProjectOpen';
import type { RuntimeAPIs } from './lib/api/types';

/** Receive desktop directory requests outside the auth and compatibility gates so recovery can switch to Local. */
export function AppRoot({ apis }: { apis: RuntimeAPIs }) {
  useDesktopProjectOpen();
  return (
    <SessionAuthGate>
      <App apis={apis} />
    </SessionAuthGate>
  );
}
