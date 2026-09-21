import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.openchamber.app',
  appName: 'OpenChamber',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // The Android WebView serves the app from an https:// origin, so its fetch
    // and WebSocket calls to plain-http LAN servers (http://192.168.x.x) are
    // blocked as mixed content even with cleartext allowed in the manifest.
    // Allow it — LAN transport is a core feature; iOS has no equivalent issue
    // (capacitor:// scheme) and relay/tunnel traffic is TLS anyway.
    allowMixedContent: true,
  },
  plugins: {
    Keyboard: {
      // 'none' leaves the WebView at full height; the UI follows the keyboard
      // itself via the --oc-keyboard-inset CSS variable driven by keyboardWillShow
      // (see useNativeMobileChrome). The built-in 'native' resize lands only after
      // the keyboard animation finishes, which looked like a ~1.5s lag.
      resize: 'none',
      resizeOnFullScreen: true,
      autoBackdropColor: 'dom',
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'DEFAULT',
    },
    PushNotifications: {
      // Never display an APNs alert while the app is foreground. The server always sends
      // (no racy visibility gate); iOS suppresses the foreground banner, so there is no
      // notification when the app is active. Background pushes are shown by iOS as usual.
      presentationOptions: [],
    },
  },
};

export default config;
