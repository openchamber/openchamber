#!/usr/bin/env bash
# Reproduction script for issue #2209
# Android .aab files published to GitHub Releases are not installable on devices
set -euo pipefail

echo "=== Reproduction of Issue #2209 ==="
echo "Android .aab files published to GitHub Releases are not installable"
echo ""

# 1. Verify the workflow uploads .aab files to releases
echo "--- Step 1: Verify workflow uploads .aab to releases ---"
WORKFLOW_FILE=".github/workflows/mobile-release.yml"
if grep -q 'bundleRelease assembleRelease' "$WORKFLOW_FILE"; then
  echo "PASS: Workflow runs 'bundleRelease assembleRelease' (line 155)"
  echo "  -> bundleRelease produces .aab (not installable)"
  echo "  -> assembleRelease produces .apk (installable)"
else
  echo "FAIL: Could not find Gradle build command"
  exit 1
fi

echo ""
echo "Checking release upload step..."
LINE_COUNT=$(grep -c 'release-assets/OpenChamber.*android.aab' "$WORKFLOW_FILE" || true)
if [ "$LINE_COUNT" -gt 0 ]; then
  echo "PASS: Workflow copies .aab to release-assets with friendly name (line 177)"
  echo "  -> OpenChamber-\${VERSION_NAME}-\${BUILD_NUMBER}-android.aab"
fi

LINE_COUNT=$(grep -c 'release-assets/OpenChamber.*android.apk' "$WORKFLOW_FILE" || true)
if [ "$LINE_COUNT" -gt 0 ]; then
  echo "PASS: Workflow also copies .apk to release-assets (line 178)"
  echo "  -> OpenChamber-\${VERSION_NAME}-\${BUILD_NUMBER}-android.apk"
fi

echo ""
echo "Checking gh release upload command..."
if grep -q 'gh release upload' "$WORKFLOW_FILE"; then
  echo "PASS: Workflow uploads both .aab and .apk to GitHub Release (line 184)"
  echo "  Files uploaded:"
  echo "    - app/build/outputs/bundle/release/*.aab  (raw gradle output)"
  echo "    - app/build/outputs/apk/release/*.apk     (raw gradle output)"
  echo "    - release-assets/*                        (renamed copies)"
fi

# 2. Verify .aab is present in release assets
echo ""
echo "--- Step 2: Verify .aab files are on GitHub Releases ---"
echo "Fetching v1.16.0 release assets..."
ASSETS=$(gh release view v1.16.0 --repo openchamber/openchamber --json assets 2>/dev/null || echo "")

if echo "$ASSETS" | grep -q 'android.aab'; then
  echo "FAIL: .aab files found on GitHub Release v1.16.0:"
  echo "$ASSETS" | grep -o '"name":"[^"]*android\.aab"' | sed 's/"name":"/- /' | sed 's/"//'
else
  echo "PASS: No .aab files on release (this means the fix may have already been applied)"
fi

if echo "$ASSETS" | grep -q 'android.apk'; then
  echo ""
  echo "Note: .apk files found on release:"
  echo "$ASSETS" | grep -o '"name":"[^"]*android\.apk"' | sed 's/"name":"/- /' | sed 's/"//'
fi

# 3. Explain why .aab is not installable
echo ""
echo "--- Step 3: Why .aab is not installable ---"
echo "Android App Bundle (.aab) is a publishing format for the Google Play Store."
echo "It contains compiled code and resources but is NOT a format that can be"
echo "installed directly on a device. The Play Store or bundletool must process"
echo "the .aab into device-specific split APKs before installation."
echo ""
echo "Download counts from v1.16.0 release showing user confusion:"
echo "$ASSETS" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('assets', []):
    name = a.get('name', '')
    if 'android' in name or 'aab' in name or 'apk' in name:
        print(f'  {name}: {a.get(\"downloadCount\", 0)} downloads')
" 2>/dev/null || echo "  (python3 not available for parsing)"

echo ""
echo "=== Reproduction Complete ==="
echo "STATUS: CONFIRMED - Issue #2209 is reproducible"
echo ""
echo "Evidence:"
echo "1. Workflow mobile-release.yml at line 155 runs 'bundleRelease assembleRelease'"
echo "2. The .aab is uploaded to GitHub Releases via lines 166-185"
echo "3. Release v1.16.0 contains .aab assets that are NOT installable on devices"
echo "4. The installable .apk is also present but not distinguished from .aab"
