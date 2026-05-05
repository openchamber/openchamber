import { randomUUID } from 'crypto';

const READ_GRANT_TTL_MS = 5 * 60 * 1000;
const WRITE_GRANT_TTL_MS = 60 * 1000;

export function createAgentTerminalService(terminalRuntime) {
  const readGrants = new Map();
  const writeGrants = new Map();

  const pruneExpired = () => {
    const now = Date.now();
    for (const [token, grant] of readGrants) {
      if (now > grant.expiresAt) readGrants.delete(token);
    }
    for (const [token, grant] of writeGrants) {
      if (now > grant.expiresAt) writeGrants.delete(token);
    }
  };

  const issueReadGrant = (sessionId) => {
    if (!terminalRuntime.getSession(sessionId)) return null;
    const token = randomUUID();
    readGrants.set(token, {
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + READ_GRANT_TTL_MS,
    });
    return token;
  };

  const issueWriteGrant = (sessionId, command) => {
    if (!terminalRuntime.getSession(sessionId)) return null;
    const token = randomUUID();
    writeGrants.set(token, {
      sessionId,
      command,
      createdAt: Date.now(),
      expiresAt: Date.now() + WRITE_GRANT_TTL_MS,
      used: false,
    });
    return token;
  };

  const revokeReadGrant = (token) => {
    readGrants.delete(token);
  };

  const revokeWriteGrant = (token) => {
    writeGrants.delete(token);
  };

  const validateReadGrant = (token) => {
    pruneExpired();
    const grant = readGrants.get(token);
    if (!grant) return null;
    return grant.sessionId;
  };

  const validateWriteGrant = (token) => {
    pruneExpired();
    const grant = writeGrants.get(token);
    if (!grant || grant.used) return null;
    return grant;
  };

  const consumeWriteGrant = (token) => {
    const grant = writeGrants.get(token);
    if (grant) grant.used = true;
  };

  const getAccessibleSession = (readGrantToken) => {
    const sessionId = validateReadGrant(readGrantToken);
    if (!sessionId) return null;

    return terminalRuntime.getSession(sessionId);
  };

  const readOutput = (readGrantToken) => {
    const sessionId = validateReadGrant(readGrantToken);
    if (!sessionId) return null;

    return terminalRuntime.readRecentOutput(sessionId);
  };

  const writeCommand = (writeGrantToken, callerCommand) => {
    const grant = validateWriteGrant(writeGrantToken);
    if (!grant) return { success: false, error: 'Invalid or expired write grant' };

    if (callerCommand && callerCommand !== grant.command) {
      return { success: false, error: `Command mismatch: grant is for "${grant.command}" not "${callerCommand}"` };
    }

    const sessionId = grant.sessionId;
    const session = terminalRuntime.getSession(sessionId);
    if (!session) return { success: false, error: 'Terminal session not found' };

    consumeWriteGrant(writeGrantToken);

    const data = grant.command + '\n';
    const ok = terminalRuntime.writeInput(sessionId, data);
    if (!ok) return { success: false, error: 'Failed to write to terminal' };

    return { success: true, sessionId, command: grant.command };
  };

  const subscribeOutput = (readGrantToken, listener) => {
    const sessionId = validateReadGrant(readGrantToken);
    if (!sessionId) return () => {};

    return terminalRuntime.subscribeOutput(sessionId, listener);
  };

  return {
    issueReadGrant,
    issueWriteGrant,
    revokeReadGrant,
    revokeWriteGrant,
    validateReadGrant,
    validateWriteGrant,
    consumeWriteGrant,
    getAccessibleSession,
    readOutput,
    writeCommand,
    subscribeOutput,
  };
}
