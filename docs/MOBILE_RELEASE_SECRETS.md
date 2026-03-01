# Mobile Release Secrets

This document lists all GitHub Secrets used by the mobile release pipeline (`.github/workflows/mobile-release.yml`) and how to generate them.

Add them in GitHub at:
- Repo `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

## Required by purpose

### 1) Android signed APK/AAB builds

Required secrets:
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Generate keystore (example):

```bash
keytool -genkeypair -v \
  -keystore openchamber-upload.jks \
  -alias openchamber \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Encode keystore to base64:

```bash
base64 -i openchamber-upload.jks | pbcopy
```

Use copied value as `ANDROID_KEYSTORE_BASE64`.

References:
- Android signing overview: https://developer.android.com/tools/publishing/app-signing
- Play App Signing: https://developer.android.com/guide/app-bundle/play-app-signing

### 2) Google Play internal track upload

Required secrets:
- `GOOGLE_PLAY_JSON_KEY` (recommended)
  - Alternative: `GOOGLE_PLAY_JSON_KEY_PATH` (mainly local/self-hosted use)

How to get:
1. Create a Google Cloud service account.
2. Enable Google Play Developer API.
3. Grant that service account access in Play Console (role with release permissions).
4. Create/download JSON key for that service account.
5. Paste JSON content into `GOOGLE_PLAY_JSON_KEY` secret.

References:
- API access and service accounts: https://developers.google.com/android-publisher/api-access
- Play Console service accounts help: https://support.google.com/googleplay/android-developer/answer/9884577?hl=en
- Fastlane supply setup: https://docs.fastlane.tools/actions/upload_to_play_store/

### 3) TestFlight upload

Required secrets:
- `APP_STORE_CONNECT_API_KEY_KEY_ID`
- `APP_STORE_CONNECT_API_KEY_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY_KEY`

Optional secret:
- `APP_STORE_CONNECT_API_KEY_BASE64` (`true`/`false`, only if key is stored base64)

How to get:
1. In App Store Connect, create an API key under `Users and Access` -> `Integrations` -> `Keys`.
2. Save:
   - Key ID -> `APP_STORE_CONNECT_API_KEY_KEY_ID`
   - Issuer ID -> `APP_STORE_CONNECT_API_KEY_ISSUER_ID`
   - `.p8` private key file contents -> `APP_STORE_CONNECT_API_KEY_KEY`

References:
- Fastlane App Store Connect API keys: https://docs.fastlane.tools/app-store-connect-api-key/
- Apple docs (distribution/testing): https://developer.apple.com/documentation/xcode/distribute-your-app-for-testing

### 4) iOS signing material (only needed if your runner must import cert/profile)

Optional secrets:
- `IOS_CERTIFICATE` (base64-encoded `.p12`)
- `IOS_CERTIFICATE_PASSWORD`
- `IOS_PROVISIONING_PROFILE` (base64-encoded `.mobileprovision`)

How to get certificate/profile:
1. Create/download Apple Distribution certificate.
2. Export certificate as `.p12` from Keychain Access.
3. Base64 encode `.p12` and `.mobileprovision` files.

Encode examples:

```bash
base64 -i distribution.p12 | pbcopy
base64 -i openchamber.mobileprovision | pbcopy
```

References:
- Create distribution certificate: https://developer.apple.com/documentation/xcode/creating-a-distribution-certificate
- Create provisioning profile: https://developer.apple.com/documentation/xcode/creating-a-provisioning-profile

### 5) F-Droid signed repo publishing

Required secrets:
- `FDROID_KEYSTORE_BASE64`
- `FDROID_KEYSTORE_PASSWORD`
- `FDROID_KEY_PASSWORD`

Optional secrets:
- `FDROID_REPO_KEY_ALIAS` (default: `repokey`)
- `FDROID_REPO_KEY_DNAME`

Generate keystore (example):

```bash
keytool -genkey -v \
  -keystore fdroid-repo.jks \
  -alias repokey \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Encode:

```bash
base64 -i fdroid-repo.jks | pbcopy
```

References:
- F-Droid signing docs: https://f-droid.org/docs/Signing/
- F-Droid configuration docs: https://f-droid.org/docs/Configuration/

## Non-secret workflow inputs (configure in workflow_dispatch)

These are inputs, not secrets:
- `android_targets`
- `android_split_per_abi`
- `android_build_apk`
- `android_build_aab`
- `ios_export_method`
- `publish_github_release`
- `upload_play_internal`
- `upload_testflight`
- `publish_fdroid_repo`
- `fdroid_repo_url`

## Quick sanity checklist

- Android release upload fails with signing errors: verify all `ANDROID_*` secrets.
- Play upload fails with auth/permission: verify `GOOGLE_PLAY_JSON_KEY` and Play Console permissions.
- TestFlight upload fails with auth: verify `APP_STORE_CONNECT_API_KEY_*` values and key role.
- F-Droid publish job skipped: verify all required `FDROID_*` secrets exist.
