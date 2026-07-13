import {
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
} from './types.js';

const PROVIDER_INSTALL_INFO = {
  [TUNNEL_PROVIDER_CLOUDFLARE]: {
    dependency: 'cloudflared',
    installUrl: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflared/downloads/',
    commands: {
      darwin: 'brew install cloudflared',
      win32: 'winget install --id Cloudflare.cloudflared',
      linux: 'Download cloudflared from https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflared/downloads/',
    },
  },
  [TUNNEL_PROVIDER_NGROK]: {
    dependency: 'ngrok',
    installUrl: 'https://ngrok.com/download',
    commands: {
      darwin: 'brew install ngrok',
      win32: 'winget install ngrok -s msstore',
      linux: 'Download ngrok from https://ngrok.com/download',
    },
  },
};

const normalizeInstallPlatform = (platform) => {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    return platform;
  }
  return 'linux';
};

const createMissingDependencyMessage = ({ dependency, installCommand }) => {
  if (installCommand.startsWith('Download ')) {
    return `${dependency} is not installed. ${installCommand}`;
  }
  return `${dependency} is not installed. Install it with: ${installCommand}`;
};

export function getTunnelDependencyInstallInfo(provider, platform = process.platform) {
  const providerInfo = PROVIDER_INSTALL_INFO[provider] || PROVIDER_INSTALL_INFO[TUNNEL_PROVIDER_CLOUDFLARE];
  const normalizedPlatform = normalizeInstallPlatform(platform);
  const installCommand = providerInfo.commands[normalizedPlatform] || providerInfo.commands.linux;

  return {
    dependency: providerInfo.dependency,
    installCommand,
    installUrl: providerInfo.installUrl,
    platform: normalizedPlatform,
    message: createMissingDependencyMessage({
      dependency: providerInfo.dependency,
      installCommand,
    }),
  };
}
