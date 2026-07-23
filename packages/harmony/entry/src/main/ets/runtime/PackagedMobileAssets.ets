import { resourceManager } from '@kit.LocalizationKit';

const VIRTUAL_ORIGIN_PREFIX = 'https://localhost/';
const RAWFILE_ROOT = 'mobile/';
const ASSET_PREFIX = 'assets/';

const ROOT_ASSET_EXTENSIONS: string[] = [
  '.css',
  '.html',
  '.ico',
  '.js',
  '.json',
  '.png',
  '.svg',
  '.webmanifest',
];

/**
 * Serves the generated MobileApp bundle from the HAP while preserving the
 * packaged-client Origin expected by the existing OpenChamber server.
 *
 * Only known static resource shapes are intercepted. Runtime routes such as
 * /api, /auth and /health deliberately fall through to ArkWeb networking.
 */
export class PackagedMobileAssets {
  private readonly resources: resourceManager.ResourceManager;

  constructor(resources: resourceManager.ResourceManager) {
    this.resources = resources;
  }

  intercept(request: WebResourceRequest): WebResourceResponse | null {
    if (request.getRequestMethod() !== 'GET') {
      return null;
    }

    const rawfilePath = this.resolveRawfilePath(request.getRequestUrl());
    if (!rawfilePath) {
      return null;
    }

    const response = new WebResourceResponse();
    try {
      const content = this.resources.getRawFileContentSync(rawfilePath);
      response.setResponseData(content.buffer);
      response.setResponseMimeType(this.mimeTypeFor(rawfilePath));
      response.setResponseEncoding('UTF-8');
      response.setResponseCode(200);
      response.setReasonMessage('OK');
    } catch (_) {
      response.setResponseData('');
      response.setResponseMimeType('text/plain');
      response.setResponseEncoding('UTF-8');
      response.setResponseCode(404);
      response.setReasonMessage('Not Found');
    }
    response.setResponseIsReady(true);
    return response;
  }

  private resolveRawfilePath(requestUrl: string): string | null {
    if (!requestUrl.startsWith(VIRTUAL_ORIGIN_PREFIX)) {
      return null;
    }

    const urlWithoutQuery = requestUrl.split('?', 1)[0].split('#', 1)[0];
    let relativePath = urlWithoutQuery.substring(VIRTUAL_ORIGIN_PREFIX.length);
    if (!relativePath || relativePath === 'index.html') {
      relativePath = 'index.html';
    }

    if (relativePath.includes('..') || relativePath.includes('\\') || relativePath.includes('%')) {
      return null;
    }

    if (relativePath.startsWith(ASSET_PREFIX)) {
      return RAWFILE_ROOT + relativePath;
    }

    if (relativePath.includes('/')) {
      return null;
    }

    for (const extension of ROOT_ASSET_EXTENSIONS) {
      if (relativePath.endsWith(extension)) {
        return RAWFILE_ROOT + relativePath;
      }
    }
    return null;
  }

  private mimeTypeFor(path: string): string {
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.js')) return 'text/javascript';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.webmanifest')) return 'application/manifest+json';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    if (path.endsWith('.woff2')) return 'font/woff2';
    if (path.endsWith('.woff')) return 'font/woff';
    if (path.endsWith('.ttf')) return 'font/ttf';
    if (path.endsWith('.wasm')) return 'application/wasm';
    return 'application/octet-stream';
  }
}
