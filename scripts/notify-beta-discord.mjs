#!/usr/bin/env node

/**
 * Script to send rich Discord notifications for Beta builds (Mobile & Desktop).
 * Usage:
 *   node scripts/notify-beta-discord.mjs --platform mobile --version 1.15.0-beta.1 --build 42 --tag beta-v1.15.0-beta.1 --apk-url "https://..." --tf-url "https://..."
 *   node scripts/notify-beta-discord.mjs --platform desktop --version 1.15.0-beta.1 --build 42 --tag desktop-beta-v1.15.0-beta.1 --release-url "https://..."
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    platform: 'mobile',
    version: '',
    build: '',
    tag: '',
    apkUrl: '',
    tfUrl: '',
    releaseUrl: '',
    webhookUrl: process.env.DISCORD_BETA_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '',
    roleId: (process.env.DISCORD_BETA_ROLE_ID || '').trim(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--platform' && args[i + 1]) result.platform = args[++i];
    else if (arg === '--version' && args[i + 1]) result.version = args[++i];
    else if (arg === '--build' && args[i + 1]) result.build = args[++i];
    else if (arg === '--tag' && args[i + 1]) result.tag = args[++i];
    else if (arg === '--apk-url' && args[i + 1]) result.apkUrl = args[++i];
    else if (arg === '--tf-url' && args[i + 1]) result.tfUrl = args[++i];
    else if (arg === '--release-url' && args[i + 1]) result.releaseUrl = args[++i];
  }

  return result;
}

async function main() {
  const { platform, version, build, tag, apkUrl, tfUrl, releaseUrl, webhookUrl, roleId } = parseArgs();

  if (!webhookUrl) {
    console.log('DISCORD_BETA_WEBHOOK_URL / DISCORD_WEBHOOK_URL not set; skipping Discord notification.');
    process.exit(0);
  }

  const isMobile = platform.toLowerCase() === 'mobile';
  const title = isMobile
    ? `📱 OpenChamber Mobile Beta v${version}`
    : `💻 OpenChamber Desktop & Extension Beta v${version}`;

  const mainUrl = releaseUrl || (tag ? `https://github.com/openchamber/openchamber/releases/tag/${tag}` : '');
  const fields = [];

  if (isMobile) {
    if (apkUrl) {
      fields.push({
        name: '🤖 Android APK',
        value: `[Download Direct APK](${apkUrl})`,
        inline: true,
      });
    }
    if (tfUrl) {
      fields.push({
        name: '🍏 iOS TestFlight',
        value: `[Join TestFlight](${tfUrl})`,
        inline: true,
      });
    }
  } else {
    fields.push(
      {
        name: '🍎 macOS (arm64 / x64)',
        value: 'DMG & ZIP installers available',
        inline: true,
      },
      {
        name: '🪟 Windows (x64 / arm64)',
        value: 'EXE installer available',
        inline: true,
      },
      {
        name: '🐧 Linux (x64 / arm64)',
        value: 'AppImage available',
        inline: true,
      },
      {
        name: '🧩 VS Code & NPM',
        value: 'VSIX / `@beta` tag',
        inline: true,
      }
    );
  }

  if (mainUrl) {
    fields.push({
      name: '📦 GitHub Release Tag',
      value: `[\`${tag || version}\`](${mainUrl})`,
      inline: false,
    });
  }

  const mention = /^\d+$/.test(roleId) ? `<@&${roleId}>` : '';

  // Embed image: use QR code if TestFlight or APK URL available
  const qrTarget = tfUrl || apkUrl;
  const image = qrTarget
    ? { url: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrTarget)}` }
    : undefined;

  const payload = {
    username: 'OpenChamber Beta Bot',
    ...(mention ? { content: mention } : {}),
    ...(mention ? { allowed_mentions: { roles: [roleId] } } : {}),
    embeds: [
      {
        title,
        url: mainUrl || undefined,
        description: `Automated beta build #${build} is ready for testing!`,
        color: isMobile ? 3447003 : 10181046, // Blue for mobile, Purple for desktop
        fields,
        image,
        footer: {
          text: 'OpenChamber Automated Beta Pipeline',
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord Webhook failed with HTTP ${response.status}: ${text}`);
    }

    console.log(`Successfully sent Discord beta notification for ${platform} v${version}.`);
  } catch (error) {
    console.error('Failed to send Discord beta notification:', error);
    process.exit(1);
  }
}

main();
