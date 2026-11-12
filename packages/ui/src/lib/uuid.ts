/**
 * An RFC 4122 version 4 UUID.
 *
 * `crypto.randomUUID()` exists only in secure contexts, so a plain-HTTP LAN or
 * Tailscale origin has none. `crypto.getRandomValues()` is available in every
 * context, so the fallback builds the same v4 layout from it.
 */
export function generateUuid(): string {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
