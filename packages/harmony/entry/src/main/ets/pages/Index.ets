import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

import { HarmonyMobileBridge } from '../bridge/HarmonyMobileBridge';
import { harmonyLifecycleChannel } from '../runtime/HarmonyLifecycleChannel';
import { PackagedMobileAssets } from '../runtime/PackagedMobileAssets';

const DOMAIN = 0x0000;
const TAG = 'OpenChamberHarmony';
const BRIDGE_NAME = 'openChamberHarmony';
const BRIDGE_METHODS: string[] = ['getPlatform', 'getBridgeVersion', 'getCapabilities'];
const BRIDGE_ASYNC_METHODS: string[] = ['secureStorageGet', 'secureStorageSet', 'secureStorageRemove'];
const MOBILE_APP_URL = 'https://localhost/index.html';

// The bridge is deliberately restricted to the packaged MobileApp virtual Origin.
const HTTPS_LOCALHOST_BRIDGE_PERMISSION =
  '{"javascriptProxyPermission":{"urlPermissionList":[{"scheme":"https","host":"localhost","port":"","path":""}]}}';

@Entry
@Component
struct Index {
  private readonly controller: webview.WebviewController = new webview.WebviewController();
  private readonly bridge: HarmonyMobileBridge = new HarmonyMobileBridge(this.controller);
  private bridgeRegistered: boolean = false;
  private lifecycleCleanup: (() => void) | null = null;
  private packagedAssets: PackagedMobileAssets | null = null;

  aboutToDisappear(): void {
    this.lifecycleCleanup?.();
    this.lifecycleCleanup = null;
    if (!this.bridgeRegistered) {
      return;
    }

    try {
      this.controller.deleteJavaScriptRegister(BRIDGE_NAME);
    } catch (_) {
      // The controller may already be detached while the ability is closing.
    }
    this.bridgeRegistered = false;
  }

  build() {
    Column() {
      Web({ src: MOBILE_APP_URL, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        // Direct LAN runtimes are a core mobile transport. The bridge remains
        // separately restricted to the packaged https://localhost document.
        .mixedMode(MixedMode.All)
        .onControllerAttached(() => {
          this.registerMobileBridge();
        })
        .onInterceptRequest((event) => {
          if (!this.packagedAssets) {
            const hostContext = this.getUIContext().getHostContext();
            if (!hostContext) {
              return null;
            }
            this.packagedAssets = new PackagedMobileAssets(hostContext.resourceManager);
          }
          return this.packagedAssets.intercept(event.request);
        })
        .width('100%')
        .height('100%');
    }
    .width('100%')
    .height('100%');
  }

  private registerMobileBridge(): void {
    if (this.bridgeRegistered) {
      return;
    }

    try {
      this.controller.registerJavaScriptProxy(
        this.bridge,
        BRIDGE_NAME,
        BRIDGE_METHODS,
        BRIDGE_ASYNC_METHODS,
        HTTPS_LOCALHOST_BRIDGE_PERMISSION,
      );
      this.bridgeRegistered = true;
      this.lifecycleCleanup = harmonyLifecycleChannel.subscribe((active: boolean) => {
        void this.bridge.publishLifecycleState(active);
      });
    } catch (_) {
      hilog.error(DOMAIN, TAG, 'Failed to register the ArkWeb mobile bridge');
    }
  }

}
