# OpenChamber Android TWA Builder

Build Android APK and App Bundle for your self-hosted OpenChamber PWA using Trusted Web Activity (TWA).

## Overview

This package generates Android applications that wrap your OpenChamber web instance in a native shell using Chrome's Trusted Web Activity. Users get:
- Full-screen PWA experience (no URL bar when properly configured)
- Play Store distribution capability
- Native app performance and feel

## Prerequisites

- **Node.js**: 20.0.0 or higher
- **JDK**: 17 or higher
- **Android SDK**: Auto-installed by Bubblewrap (or set ANDROID_HOME)
- **HTTPS**: Your OpenChamber instance MUST be served over HTTPS

## Quick Start

```bash
# 1. Set your configuration
export TWA_MANIFEST_URL=https://your-domain.com/site.webmanifest
export TWA_HOST=your-domain.com

# 2. Initialize TWA project
bun run android:init

# 3. Build APK
bun run android:build

# 4. Generate assetlinks.json
bun run android:assetlinks
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TWA_MANIFEST_URL` | ✅ | - | Full URL to your site.webmanifest |
| `TWA_HOST` | ✅ | - | Your domain hostname (without https://) |
| `TWA_PACKAGE_ID` | ⬜ | `ai.opencode.openchamber.twa` | Android package ID |
| `TWA_KEYSTORE_PATH` | ⬜ | `./android.keystore` | Path to existing keystore |
| `TWA_KEY_ALIAS` | ⬜ | `openchamber` | Keystore key alias |
| `BUBBLEWRAP_KEYSTORE_PASSWORD` | ⬜ | - | Keystore password (for CI/CD) |

### .env File

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
# Edit .env with your configuration
```

## Step-by-Step Guide

### 1. Install Bubblewrap CLI

```bash
npm install -g @bubblewrap/cli
```

### 2. Configure Your Instance

Set environment variables or create `.env` file with your OpenChamber URL.

**Example**:
```bash
export TWA_MANIFEST_URL=https://my-server.com/site.webmanifest
export TWA_HOST=my-server.com
```

### 3. Initialize TWA Project

```bash
bun run android:init
```

This will:
- Download your PWA manifest
- Create TWA configuration
- Generate Android project files

### 4. Generate Signing Key

If you don't have a keystore, the init script will offer to create one.

**For existing keystores**, set:
```bash
export TWA_KEYSTORE_PATH=/path/to/your.keystore
export TWA_KEY_ALIAS=your-key-alias
```

### 5. Build APK

```bash
bun run android:build
```

Output: `packages/android-twa/output/app-release-signed.apk`

### 6. Deploy assetlinks.json

```bash
bun run android:assetlinks
```

Upload the generated `assetlinks.json` to your server:
- Location: `https://your-domain.com/.well-known/assetlinks.json`
- Content-Type: `application/json`

### 7. Test on Device

```bash
adb install packages/android-twa/output/app-release-signed.apk
```

Verify:
- App opens full-screen (no URL bar)
- All features work correctly

### 8. Build for Play Store (Optional)

```bash
bun run android:build:aab
```

Output: `packages/android-twa/output/app-release-bundle.aab`

Upload to [Play Console](https://play.google.com/console).

## Signing Key Management

### Security Best Practices

⚠️ **NEVER commit keystores or passwords to git!**

- Store keystores securely (outside project directory)
- Use environment variables for passwords in CI/CD
- Back up your keystore - loss means you can't update your app

### Generating a New Keystore

```bash
keytool -genkeypair -alias openchamber \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -keystore android.keystore
```

### Extracting Fingerprint

```bash
bun run android:fingerprint
```

Use this fingerprint for assetlinks.json verification.

## Play Store Publishing

### Requirements

- Google Play Developer account ($25 one-time fee)
- Valid AAB file
- Store listing assets (icons, screenshots)

### Steps

1. Build AAB: `bun run android:build:aab`
2. Go to [Play Console](https://play.google.com/console)
3. Create new app
4. Upload AAB in Release section
5. Complete store listing
6. Submit for review

### Store Listing Tips

- **Title**: OpenChamber - AI Coding Companion (max 50 chars)
- **Short description**: Your AI coding assistant on Android (max 80 chars)
- **Category**: Productivity, Developer Tools
- Include screenshots showing chat interface

## Troubleshooting

### URL Bar Still Showing

**Cause**: assetlinks.json not properly deployed

**Solution**:
1. Verify `https://your-domain.com/.well-known/assetlinks.json` is accessible
2. Check Content-Type is `application/json`
3. Verify SHA-256 fingerprint matches your keystore
4. Test with [Google's Asset Links Tool](https://developers.google.com/digital-asset-links/tools/generator)

### App Crashes on Launch

**Cause**: CORS/CSP headers blocking requests

**Solution**: Ensure your server allows requests from the TWA origin.

### HTTPS Required

**Cause**: Using HTTP URL

**Solution**: TWA requires HTTPS. Use a reverse proxy like Nginx or Caddy.

### Bubblewrap Not Found

**Solution**:
```bash
npm install -g @bubblewrap/cli
# or
yarn global add @bubblewrap/cli
```

## Architecture

```
packages/android-twa/
├── scripts/           # Build scripts
│   ├── init-twa.mjs   # Initialize TWA
│   ├── build-apk.mjs  # Build APK
│   ├── build-aab.mjs  # Build AAB
│   └── ...
├── templates/         # Configuration templates
├── assets/icons/      # PWA icons (copied)
├── output/            # Generated TWA project (gitignored)
├── .env.example       # Configuration template
└── README.md          # This file
```

## Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| `android:init` | `bun run android:init` | Initialize TWA project |
| `android:build` | `bun run android:build` | Build signed APK |
| `android:build:aab` | `bun run android:build:aab` | Build AAB for Play Store |
| `android:assetlinks` | `bun run android:assetlinks` | Generate assetlinks.json |
| `android:fingerprint` | `bun run android:fingerprint` | Extract SHA-256 fingerprint |

## Security Notes

1. **Keystores**: Never commit `.keystore` or `.jks` files
2. **Passwords**: Use env vars, never hardcode
3. **assetlinks.json**: Only contains fingerprint (safe to commit)
4. **Personal URLs**: Never commit your actual domain to git

## License

MIT - Part of OpenChamber project
