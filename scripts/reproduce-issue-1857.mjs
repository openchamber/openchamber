/**
 * Reproduction script for issue #1857
 *
 * Bug: packages/web/bin/lib/cli-tunnel-capabilities.js imports
 * `ngrokTunnelProviderCapabilities` from `../../server/lib/tunnels/providers/ngrok.js`,
 * but ngrok.js declares it as `const ngrokTunnelProviderCapabilities` without `export`.
 *
 * The sibling cloudflare.js correctly uses `export const cloudflareTunnelProviderCapabilities`.
 *
 * Expected output: SyntaxError about the missing export (CLI crash)
 */
import { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES } from '../packages/web/bin/lib/cli-tunnel-capabilities.js';

// If execution reaches here, the fix has been applied — the import above
// will throw a SyntaxError before this line runs in the broken state.
console.log('SUCCESS: All provider capabilities resolved:', DEFAULT_TUNNEL_PROVIDER_CAPABILITIES.map(c => c.provider));
