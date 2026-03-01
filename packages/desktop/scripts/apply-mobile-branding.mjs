import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const genRoot = path.join(root, 'src-tauri', 'gen');

const androidColors = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="splash_background">#141414</color>
</resources>`;

const androidThemes = `<?xml version="1.0" encoding="utf-8"?>
<resources xmlns:tools="http://schemas.android.com/tools">
    <style name="Theme.openchamber_desktop" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="android:windowBackground">@drawable/launch_screen</item>
        <item name="android:statusBarColor">@color/splash_background</item>
        <item name="android:navigationBarColor">@color/splash_background</item>
    </style>
</resources>`;

const androidLaunchScreen = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@color/splash_background" />
  <item android:gravity="center" android:height="132dp" android:width="132dp">
    <bitmap
      android:antialias="true"
      android:filter="true"
      android:src="@mipmap/ic_launcher_foreground" />
  </item>
</layer-list>`;

const androidNetworkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>`;

const iosLaunchScreen = `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" toolsVersion="23506" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" useTraitCollections="YES" useSafeAreas="YES" colorMatched="YES" initialViewController="Y6W-OH-hqX">
    <device id="retina6_12" orientation="portrait" appearance="light"/>
    <dependencies>
        <plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="23504"/>
        <capability name="Safe area layout guides" minToolsVersion="9.0"/>
        <capability name="Named colors" minToolsVersion="9.0"/>
        <capability name="documents saved in the Xcode 8 format" minToolsVersion="8.0"/>
    </dependencies>
    <scenes>
        <scene sceneID="s0d-6b-0kx">
            <objects>
                <viewController id="Y6W-OH-hqX" sceneMemberID="viewController">
                    <view key="view" contentMode="scaleToFill" id="5EZ-qb-Rvc">
                        <rect key="frame" x="0.0" y="0.0" width="393" height="852"/>
                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
                        <subviews>
                            <label opaque="NO" userInteractionEnabled="NO" contentMode="left" text="OpenChamber" textAlignment="center" lineBreakMode="tailTruncation" baselineAdjustment="alignBaselines" adjustsFontSizeToFit="NO" translatesAutoresizingMaskIntoConstraints="NO" id="Y3t-lM-2yv">
                                <rect key="frame" x="101.66666666666669" y="413.66666666666669" width="189.99999999999997" height="24.999999999999943"/>
                                <fontDescription key="fontDescription" type="boldSystem" pointSize="28"/>
                                <color key="textColor" white="1" alpha="0.92" colorSpace="custom" customColorSpace="genericGamma22GrayColorSpace"/>
                                <nil key="highlightedColor"/>
                            </label>
                        </subviews>
                        <viewLayoutGuide key="safeArea" id="vDu-zF-Fre"/>
                        <color key="backgroundColor" name="LaunchBackground"/>
                        <constraints>
                            <constraint firstItem="Y3t-lM-2yv" firstAttribute="centerX" secondItem="5EZ-qb-Rvc" secondAttribute="centerX" id="Rjc-4i-L9H"/>
                            <constraint firstItem="Y3t-lM-2yv" firstAttribute="centerY" secondItem="5EZ-qb-Rvc" secondAttribute="centerY" id="m8Q-Qw-QmA"/>
                        </constraints>
                    </view>
                </viewController>
                <placeholder placeholderIdentifier="IBFirstResponder" id="Ief-a0-LHa" userLabel="First Responder" customClass="UIResponder" sceneMemberID="firstResponder"/>
            </objects>
        </scene>
    </scenes>
    <resources>
        <namedColor name="LaunchBackground">
            <color red="0.078431372549019607" green="0.078431372549019607" blue="0.078431372549019607" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>
        </namedColor>
    </resources>
</document>`;

const targets = [
  ['src-tauri/gen/android/app/src/main/res/values/colors.xml', androidColors],
  ['src-tauri/gen/android/app/src/main/res/values/themes.xml', androidThemes],
  ['src-tauri/gen/android/app/src/main/res/values-night/themes.xml', androidThemes],
  ['src-tauri/gen/android/app/src/main/res/drawable/launch_screen.xml', androidLaunchScreen],
  ['src-tauri/gen/android/app/src/main/res/xml/network_security_config.xml', androidNetworkSecurityConfig],
  ['src-tauri/gen/apple/LaunchScreen.storyboard', iosLaunchScreen],
];

async function patchAndroidManifest(rootDir) {
  const manifestPath = path.join(rootDir, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  if (!(await exists(manifestPath))) {
    return 0;
  }

  const original = await fs.readFile(manifestPath, 'utf8');
  let updated = original;

  if (updated.includes('android:usesCleartextTraffic="${usesCleartextTraffic}"')) {
    updated = updated.replace(
      'android:usesCleartextTraffic="${usesCleartextTraffic}"',
      'android:usesCleartextTraffic="true"\n        android:networkSecurityConfig="@xml/network_security_config"',
    );
  } else {
    if (/android:usesCleartextTraffic="[^"]*"/.test(updated)) {
      updated = updated.replace(/android:usesCleartextTraffic="[^"]*"/g, 'android:usesCleartextTraffic="true"');
    }
    if (!updated.includes('android:networkSecurityConfig=')) {
      updated = updated.replace('<application\n', '<application\n        android:networkSecurityConfig="@xml/network_security_config"\n');
    }
  }

  if (updated === original) {
    return 0;
  }

  await fs.writeFile(manifestPath, updated, 'utf8');
  return 1;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(genRoot))) {
  console.log('[mobile-branding] skipped (src-tauri/gen does not exist yet)');
  process.exit(0);
}

let updated = 0;
for (const [relativePath, content] of targets) {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${content}\n`, 'utf8');
  updated += 1;
}

updated += await patchAndroidManifest(root);

console.log(`[mobile-branding] updated ${updated} files`);
