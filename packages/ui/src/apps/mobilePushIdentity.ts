import { isActiveRuntimeConnection, pushServerIdOf, readConnections } from './mobileConnections';

export const activePushServerId = (): string | null => {
  const connection = readConnections().find(isActiveRuntimeConnection);
  return connection ? pushServerIdOf(connection) : null;
};
