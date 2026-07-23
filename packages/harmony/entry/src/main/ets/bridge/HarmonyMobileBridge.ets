import { util } from '@kit.ArkTS';
import { asset } from '@kit.AssetStoreKit';
import { webview } from '@kit.ArkWeb';
import type { BusinessError } from '@kit.BasicServicesKit';

const TOKEN_KEY_PREFIX = 'openchamber.mobile.token.';
const RESULT_CALLBACK = '__openChamberHarmonyBridgeResult';
const LIFECYCLE_CALLBACK = '__openChamberHarmonyLifecycle';
// Asset Store constrains aliases to 256 bytes and secrets to 1024 bytes.
// Validate encoded values so an invalid request never reaches the service.
const MAX_ALIAS_BYTES = 256;
const MAX_SECRET_BYTES = 1024;

/**
 * Narrow ArkWeb bridge for platform discovery, lifecycle state, and
 * OS-protected token storage.
 * Authentication, networking, files, commands, and arbitrary native dispatch
 * deliberately remain in their existing shared TypeScript owners.
 */
export class HarmonyMobileBridge {
  private readonly encoder: util.TextEncoder = new util.TextEncoder();
  private readonly decoder: util.TextDecoder = util.TextDecoder.create('utf-8', { fatal: true });
  private readonly controller: webview.WebviewController;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  getPlatform(): string {
    return 'harmony';
  }

  getBridgeVersion(): string {
    return '0.4.0';
  }

  getCapabilities(): string {
    return JSON.stringify({
      nativeHttp: false,
      secureStorage: true,
      lifecycle: true,
      keyboardChoreography: false,
      deepLinks: false,
      scanQr: false,
      push: false,
      updater: false,
      scope: 'sprint-2-lifecycle',
    });
  }

  async secureStorageGet(requestId: string, key: string): Promise<void> {
    await this.complete(requestId, () => this.readSecureStorage(key));
  }

  async secureStorageSet(requestId: string, key: string, value: string): Promise<void> {
    await this.complete(requestId, () => this.writeSecureStorage(key, value));
  }

  async secureStorageRemove(requestId: string, key: string): Promise<void> {
    await this.complete(requestId, () => this.removeSecureStorage(key));
  }

  async publishLifecycleState(active: boolean): Promise<void> {
    const script = `globalThis.${LIFECYCLE_CALLBACK}?.(${active ? 'true' : 'false'})`;
    try {
      await this.controller.runJavaScript(script);
    } catch (_) {
      // The page may still be loading or may have closed during the transition.
    }
  }

  private async readSecureStorage(key: string): Promise<string> {
    if (!this.isValidKey(key)) {
      return this.failure('invalid-key');
    }

    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encode(key));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    query.set(asset.Tag.RETURN_LIMIT, 1);

    try {
      const matches = await asset.query(query);
      if (matches.length === 0) {
        return this.success(null);
      }
      const secret = matches[0].get(asset.Tag.SECRET);
      if (!(secret instanceof Uint8Array)) {
        return this.failure('invalid-secret');
      }
      return this.success(this.decoder.decodeToString(secret));
    } catch (error) {
      if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) {
        return this.success(null);
      }
      return this.failure('storage-unavailable');
    }
  }

  private async writeSecureStorage(key: string, value: string): Promise<string> {
    const secret = this.encode(value);
    if (!this.isValidKey(key) || secret.length === 0 || secret.length > MAX_SECRET_BYTES) {
      return this.failure('invalid-input');
    }

    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.ALIAS, this.encode(key));
    attributes.set(asset.Tag.SECRET, secret);
    // Match the platform's basic password-storage flow. The token stays
    // inaccessible until the device has been unlocked once after boot.
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);

    try {
      await asset.add(attributes);
      return this.success();
    } catch (error) {
      const failure = error as BusinessError;
      if (failure.code !== asset.ErrorCode.DUPLICATED) {
        return this.failure(this.classifyStorageError(failure));
      }

      // Keep add() on the platform's documented minimal attribute set. A retry
      // for an existing alias updates only the encrypted secret instead of
      // relying on add-time conflict-resolution extensions.
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, this.encode(key));
      const updates: asset.AssetMap = new Map();
      updates.set(asset.Tag.SECRET, secret);
      try {
        await asset.update(query, updates);
        return this.success();
      } catch (updateError) {
        return this.failure(this.classifyStorageError(updateError as BusinessError));
      }
    }
  }

  private async removeSecureStorage(key: string): Promise<string> {
    if (!this.isValidKey(key)) {
      return this.failure('invalid-key');
    }

    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encode(key));
    try {
      await asset.remove(query);
      return this.success();
    } catch (error) {
      if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) {
        return this.success();
      }
      return this.failure('storage-unavailable');
    }
  }

  private encode(value: string): Uint8Array {
    return this.encoder.encodeInto(value);
  }

  private isValidKey(key: string): boolean {
    if (!key.startsWith(TOKEN_KEY_PREFIX)) {
      return false;
    }
    const encoded = this.encode(key);
    return encoded.length > TOKEN_KEY_PREFIX.length && encoded.length <= MAX_ALIAS_BYTES;
  }

  private classifyStorageError(error: BusinessError): string {
    const code = error.code;
    if (code === 201) {
      return 'permission-denied';
    }
    if (code === 401) {
      return 'invalid-input';
    }
    if (code === asset.ErrorCode.STATUS_MISMATCH) {
      return 'device-locked';
    }
    if (code === asset.ErrorCode.ACCESS_DENIED) {
      return 'access-denied';
    }
    return 'storage-unavailable';
  }

  private async complete(requestId: string, operation: () => Promise<string>): Promise<void> {
    if (!/^[a-z0-9-]{1,64}$/.test(requestId)) {
      return;
    }
    let result: string;
    try {
      result = await operation();
    } catch (_) {
      result = this.failure('storage-unavailable');
    }
    const script = `globalThis.${RESULT_CALLBACK}?.(${JSON.stringify(requestId)}, ${JSON.stringify(result)})`;
    try {
      await this.controller.runJavaScript(script);
    } catch (_) {
      // The page may have navigated or closed before the storage operation ends.
    }
  }

  private success(value?: string | null): string {
    return value === undefined
      ? JSON.stringify({ ok: true })
      : JSON.stringify({ ok: true, value });
  }

  private failure(error: string): string {
    return JSON.stringify({ ok: false, error });
  }
}
