
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

const STORAGE_SOURCE = `(function () {
  var make = function () {
    var items = new Map();
    var own = function (key) { return typeof key === 'string' && items.has(key); };
    var api = {
      getItem: function (key) { key = String(key); return items.has(key) ? items.get(key) : null; },
      setItem: function (key, value) { items.set(String(key), String(value)); },
      removeItem: function (key) { items.delete(String(key)); },
      clear: function () { items.clear(); },
      key: function (index) { var keys = Array.from(items.keys()); return index in keys ? keys[index] : null; }
    };
    Object.defineProperty(api, 'length', { get: function () { return items.size; } });
    return new Proxy(Object.create(api), {
      get: function (target, key) { return key in target ? target[key] : own(key) ? items.get(key) : undefined; },
      set: function (target, key, value) { items.set(String(key), String(value)); return true; },
      has: function (target, key) { return key in target || own(key); },
      deleteProperty: function (target, key) { items.delete(String(key)); return true; },
      ownKeys: function () { return Array.from(items.keys()); },
      getOwnPropertyDescriptor: function (target, key) {
        return own(key) ? { value: items.get(key), writable: true, enumerable: true, configurable: true } : undefined;
      }
    });
  };
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try {
      void window[name];
    } catch (error) {
      Object.defineProperty(window, name, { value: make(), enumerable: true, configurable: true });
    }
  });
  try {
    void document.cookie;
  } catch (error) {
    Object.defineProperty(document, 'cookie', { get: function () { return ''; }, set: function () {}, configurable: true });
  }
})();`;

const BRIDGE_TAG = `<script data-openchamber-preview-bridge>${STORAGE_SOURCE}${BRIDGE_SOURCE}</script>`;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

const startsWithBytes = (content: Buffer, bytes: number[]) => bytes.every((byte, index) => content[index] === byte);

export const injectPreviewBridge = (content: Buffer) => {
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
