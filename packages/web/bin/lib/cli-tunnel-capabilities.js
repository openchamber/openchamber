import { cloudflareTunnelProviderCapabilities } from '../../server/lib/tunnels/providers/cloudflare.js';
import { ngrokTunnelProviderCapabilities } from '../../server/lib/tunnels/providers/ngrok.js';

const DEFAULT_TUNNEL_PROVIDER_CAPABILITIES = [
  cloudflareTunnelProviderCapabilities,
  ngrokTunnelProviderCapabilities,
];

export { DEFAULT_TUNNEL_PROVIDER_CAPABILITIES };
