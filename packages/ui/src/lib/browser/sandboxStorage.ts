export const SANDBOX_STORAGE_SCRIPT = `(function () {
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
