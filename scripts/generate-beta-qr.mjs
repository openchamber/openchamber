#!/usr/bin/env node

/**
 * Helper script to generate markdown summary with QR codes for GitHub Actions step summary.
 * Usage:
 *   node scripts/generate-beta-qr.mjs --platform android --url "https://..." --version "1.15.0-beta.1" --build "42"
 *   node scripts/generate-beta-qr.mjs --platform ios --url "https://testflight.apple.com/join/..." --version "1.15.0-beta.1" --build "42"
 */

import { appendFileSync } from 'node:fs';

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    platform: 'android',
    url: '',
    version: 'dev',
    build: '1',
    out: process.env.GITHUB_STEP_SUMMARY || '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--platform' && args[i + 1]) result.platform = args[++i];
    else if (arg === '--url' && args[i + 1]) result.url = args[++i];
    else if (arg === '--version' && args[i + 1]) result.version = args[++i];
    else if (arg === '--build' && args[i + 1]) result.build = args[++i];
    else if (arg === '--out' && args[i + 1]) result.out = args[++i];
  }

  return result;
}

const { platform, url, version, build, out } = parseArgs();

if (!url) {
  console.error('Error: --url parameter is required.');
  process.exit(1);
}

const isIOS = platform.toLowerCase() === 'ios';
const title = isIOS ? '📱 iOS TestFlight Beta' : '🤖 Android Beta APK';
const encodedUrl = encodeURIComponent(url);
const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodedUrl}`;

const markdown = `
### ${title}

| Parameter | Value |
| :--- | :--- |
| **Version** | \`${version}\` |
| **Build Number** | \`${build}\` |
| **Platform** | ${isIOS ? 'iOS (TestFlight)' : 'Android (Direct APK)'} |
| **Link** | [Download / Join](${url}) |

<details open>
<summary><b>Scan QR Code to Install</b></summary>

<br />

![QR Code](${qrImageUrl})

*Direct URL: [${url}](${url})*

</details>

---
`;

if (out) {
  appendFileSync(out, markdown, 'utf8');
  console.log(`Successfully appended ${platform} beta QR code markdown to ${out}`);
} else {
  console.log(markdown);
}
