// The Files view shows an HTML preview in an opaque-origin sandbox, so the app
// cannot run code in it the way the browser panel runs code in its webview.
// Every HTML page served for a preview carries this listener instead: a script
// sent by the frame's parent is evaluated in the page and its settled value is
// posted back. Only the parent's messages are accepted. What the script can do
// is what the page's own scripts can already do, inside the same sandbox, so
// the bridge grants the app nothing the page does not have.

const PREVIEW_BRIDGE_CHANNEL = 'openchamber-preview-bridge';

const BRIDGE_SOURCE = `(function () {
  if (window.parent === window) return;
  var CHANNEL = '${PREVIEW_BRIDGE_CHANNEL}';
  var describe = function (error) { return String((error && error.message) || error); };
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== 'eval') return;
    if (typeof data.id !== 'string' || typeof data.code !== 'string') return;
    var target = event.origin && event.origin !== 'null' ? event.origin : '*';
    var reply = function (ok, value) {
      try {
        window.parent.postMessage({ channel: CHANNEL, type: 'result', id: data.id, ok: ok, value: value }, target);
      } catch (error) {
        window.parent.postMessage({ channel: CHANNEL, type: 'result', id: data.id, ok: false, value: describe(error) }, target);
      }
    };
    var result;
    try {
      result = (0, eval)(data.code);
    } catch (error) {
      reply(false, describe(error));
      return;
    }
    Promise.resolve(result).then(
      function (value) { reply(true, value === undefined ? null : value); },
      function (error) { reply(false, describe(error)); }
    );
  });
})();`;

const BRIDGE_TAG = `<script data-openchamber-preview-bridge>${BRIDGE_SOURCE}</script>`;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

const startsWithBytes = (content, bytes) => bytes.every((byte, index) => content[index] === byte);

/**
 * Returns the page with the bridge as the first script of its head.
 *
 * Works on bytes, so a page in any ASCII-compatible encoding keeps it: latin1
 * maps each byte to one character, so string offsets are byte offsets. The tag
 * goes after `<head>`, `<html>` or the doctype, whichever comes first in that
 * order of preference; a script before the doctype would switch the page to
 * quirks mode. UTF-16 pages are served unchanged.
 */
export const injectPreviewBridge = (content) => {
  if (startsWithBytes(content, [0xfe, 0xff]) || startsWithBytes(content, [0xff, 0xfe])) {
    return content;
  }
  const text = content.toString('latin1');
  const anchor = /<head\b[^>]*>/i.exec(text) ?? /<html\b[^>]*>/i.exec(text) ?? /<!doctype\b[^>]*>/i.exec(text);
  const at = anchor
    ? anchor.index + anchor[0].length
    : (startsWithBytes(content, UTF8_BOM) ? UTF8_BOM.length : 0);
  return Buffer.concat([content.subarray(0, at), Buffer.from(BRIDGE_TAG, 'latin1'), content.subarray(at)]);
};
