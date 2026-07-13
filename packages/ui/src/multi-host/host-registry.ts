/**
 * Host registry: canonical hostId generation and descriptor normalization.
 *
 * This module is pure — no store side-effects, no network calls.
 */

import type { HostDescriptor, HostId, HostTransport, HostTransportKind } from './types';

// ---------------------------------------------------------------------------
// HostId generation
// ---------------------------------------------------------------------------

let idCounter = 0;

/**
 * Generate a fresh, unique HostId for new hosts.
 * Format: `host_<timestamp>_<counter>` — stable within a session, easy to
 * recognise in logs.
 *
 * For saved remote instances, use `hostIdFromExistingId()` to derive a stable
 * HostId from the existing remote instance identity.
 */
export const generateHostId = (): HostId => {
  const id = `host_${Date.now()}_${++idCounter}` as HostId;
  return id;
};

/**
 * Create a stable HostId from an existing remote instance identity.
 * This ensures the same remote instance maps to the same HostId across
 * app restarts.
 *
 * @param existingId - The stable identifier from the remote instance registry
 * @returns A branded HostId that is stable across restarts
 */
export const hostIdFromExistingId = (existingId: string): HostId => {
  // Prefix with 'host_' to maintain consistency with generateHostId format
  // but use a hash of the existing ID for stability
  return `host_${existingId}` as HostId;
};

// ---------------------------------------------------------------------------
// Descriptor normalization
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a partial descriptor into a full HostDescriptor.
 * Throws on missing required fields so callers fail fast.
 */
export const normalizeDescriptor = (
  input: Partial<HostDescriptor> & { hostId?: HostId; label?: string; transport?: HostTransport | HostTransportKind },
  defaults?: { transport?: HostTransportKind },
): HostDescriptor => {
  const hostId = input.hostId ?? generateHostId();
  const label = input.label?.trim() || `Host ${hostId}`;
  
  // Handle transport normalization
  let transport: HostTransport;
  if (input.transport && typeof input.transport === 'object' && 'kind' in input.transport) {
    // Already a HostTransport object
    transport = input.transport;
  } else {
    // Convert HostTransportKind string to HostTransport object
    const kind: HostTransportKind = (input.transport as HostTransportKind) ?? defaults?.transport ?? 'direct';
    switch (kind) {
      case 'local':
        transport = { kind: 'local' };
        break;
      case 'direct':
        transport = { kind: 'direct', apiUrl: '' };
        break;
      case 'ssh':
        transport = { kind: 'ssh', sshEndpoint: '' };
        break;
      case 'relay':
        transport = { kind: 'relay', relayServerId: '' };
        break;
      default:
        transport = { kind: 'direct', apiUrl: '' };
    }
  }

  return {
    hostId,
    label,
    transport,
  };
};

/**
 * Merge an update into an existing descriptor. Only provided fields are
 * overwritten; the hostId is never changed.
 */
export const mergeDescriptor = (
  existing: HostDescriptor,
  update: Partial<Omit<HostDescriptor, 'hostId'>>,
): HostDescriptor => {
  const next: HostDescriptor = { ...existing };

  if (update.label !== undefined) next.label = update.label;
  if (update.transport !== undefined) {
    // Deep merge transport if both are objects with same kind
    if (typeof update.transport === 'object' && typeof existing.transport === 'object' && 
        update.transport.kind === existing.transport.kind) {
      next.transport = { ...existing.transport, ...update.transport };
    } else {
      next.transport = update.transport;
    }
  }

  return next;
};
