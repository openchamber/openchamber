(function () {
  'use strict';

  var NETWORK_TIMEOUT_MS = 8000;
  var PROBE_IDS = ['http-get', 'http-preflight', 'sse', 'websocket', 'webcrypto'];

  function setText(id, value, className) {
    var element = document.getElementById(id);
    element.textContent = value;
    element.className = className || '';
  }

  function setProbeStatus(id, value, className) {
    setText(id, value, className);
  }

  function readBridge() {
    var bridge = window.openChamberHarmony;
    if (!bridge) {
      setText('platform', '未注入', 'status-error');
      setText('bridge-version', '未注入', 'status-error');
      setText('capabilities', '未注入', 'status-error');
      return;
    }

    try {
      setText('platform', String(bridge.getPlatform()), 'status-ok');
      setText('bridge-version', String(bridge.getBridgeVersion()), 'status-ok');
      setText('capabilities', String(bridge.getCapabilities()), 'status-ok');
    } catch (_) {
      setText('platform', '调用失败', 'status-error');
      setText('bridge-version', '调用失败', 'status-error');
      setText('capabilities', '调用失败', 'status-error');
    }
  }

  function normalizedProbeBaseUrl() {
    var input = document.getElementById('probe-url');
    var value = input.value.trim();

    if (!value) {
      throw new Error('missing URL');
    }

    var baseUrl = new URL(value);
    if ((baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') || baseUrl.username || baseUrl.password) {
      throw new Error('unsupported URL');
    }

    baseUrl.pathname = '/';
    baseUrl.search = '';
    baseUrl.hash = '';
    return baseUrl;
  }

  function endpointUrl(baseUrl, path) {
    return new URL(path, baseUrl).toString();
  }

  function websocketUrl(baseUrl) {
    var url = new URL('/ws', baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  function fetchWithTimeout(url, init) {
    if (!window.AbortController) {
      return window.fetch(url, init);
    }

    var controller = new AbortController();
    var timer = window.setTimeout(function () {
      controller.abort();
    }, NETWORK_TIMEOUT_MS);
    var request = Object.assign({}, init || {}, { signal: controller.signal });

    return window.fetch(url, request).finally(function () {
      window.clearTimeout(timer);
    });
  }

  async function checkHttpGet(baseUrl) {
    var response = await fetchWithTimeout(endpointUrl(baseUrl, '/health'));
    if (!response.ok) {
      throw new Error('unexpected HTTP response');
    }

    await response.json();
  }

  async function checkHttpPreflight(baseUrl) {
    var response = await fetchWithTimeout(endpointUrl(baseUrl, '/echo'), {
      body: JSON.stringify({ probe: 'cors' }),
      headers: {
        'Content-Type': 'application/json',
        'X-OpenChamber-Probe': 'cors',
      },
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('unexpected HTTP response');
    }

    await response.json();
  }

  function checkSse(baseUrl) {
    return new Promise(function (resolve, reject) {
      var complete = false;
      var source;
      var timer = window.setTimeout(function () {
        finish(new Error('timeout'));
      }, NETWORK_TIMEOUT_MS);

      function finish(error) {
        if (complete) {
          return;
        }

        complete = true;
        window.clearTimeout(timer);
        if (source) {
          source.close();
        }

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      try {
        source = new EventSource(endpointUrl(baseUrl, '/sse'));
        source.onmessage = function (event) {
          if (event.data === '{"type":"ready"}') {
            finish();
          } else {
            finish(new Error('unexpected SSE payload'));
          }
        };
        source.onerror = function () {
          finish(new Error('SSE error'));
        };
      } catch (_) {
        finish(new Error('SSE unavailable'));
      }
    });
  }

  function checkWebSocket(baseUrl) {
    return new Promise(function (resolve, reject) {
      var complete = false;
      var sawPong = false;
      var sawReady = false;
      var socket;
      var timer = window.setTimeout(function () {
        finish(new Error('timeout'));
      }, NETWORK_TIMEOUT_MS);

      function finish(error) {
        if (complete) {
          return;
        }

        complete = true;
        window.clearTimeout(timer);
        if (socket) {
          socket.close();
        }

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      try {
        socket = new WebSocket(websocketUrl(baseUrl));
        socket.onopen = function () {
          socket.send('ping');
        };
        socket.onmessage = function (event) {
          if (event.data === '{"type":"ready"}') {
            sawReady = true;
          }
          if (event.data === 'pong') {
            sawPong = true;
          }
          if (sawReady && sawPong) {
            finish();
          }
        };
        socket.onerror = function () {
          finish(new Error('WebSocket error'));
        };
      } catch (_) {
        finish(new Error('WebSocket unavailable'));
      }
    });
  }

  async function checkWebCrypto() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('WebCrypto unavailable');
    }

    var p256 = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    var aesKey = await window.crypto.subtle.generateKey(
      { length: 256, name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    var plainText = new TextEncoder().encode('probe');
    var cipherText = await window.crypto.subtle.encrypt({ iv: iv, name: 'AES-GCM' }, aesKey, plainText);
    var decrypted = await window.crypto.subtle.decrypt({ iv: iv, name: 'AES-GCM' }, aesKey, cipherText);

    if (!p256.privateKey || new TextDecoder().decode(decrypted) !== 'probe') {
      throw new Error('WebCrypto verification failed');
    }
  }

  async function runProbe() {
    var button = document.getElementById('run-probe');
    var baseUrl;

    try {
      baseUrl = normalizedProbeBaseUrl();
    } catch (_) {
      setText('transport-summary', '请输入有效的 HTTP(S) 测试服务器根地址。', 'status-error');
      return;
    }

    button.disabled = true;
    button.textContent = '诊断中…';
    setText('transport-summary', '正在通过浏览器侧传输执行无凭据诊断…');
    PROBE_IDS.forEach(function (id) {
      setProbeStatus(id, '诊断中…');
    });

    var checks = [
      ['http-get', checkHttpGet(baseUrl), 'HTTP GET 通过'],
      ['http-preflight', checkHttpPreflight(baseUrl), 'HTTP preflight 通过'],
      ['sse', checkSse(baseUrl), 'SSE 收到 ready 事件'],
      ['websocket', checkWebSocket(baseUrl), 'WebSocket 收到 ready 与 pong'],
      ['webcrypto', checkWebCrypto(), 'P-256 与 AES-GCM 通过'],
    ];
    var results = await Promise.all(checks.map(function (check) {
      return check[1].then(function () {
        setProbeStatus(check[0], check[2], 'status-ok');
        return true;
      }).catch(function () {
        setProbeStatus(check[0], '失败（网络、Origin、CORS、能力或超时）', 'status-error');
        return false;
      });
    }));

    var successCount = results.filter(Boolean).length;
    setText(
      'transport-summary',
      successCount === checks.length
        ? '诊断完成：浏览器侧能力全部通过；仍需记录服务端 Origin 日志并测试 HTTPS/LAN HTTP 场景。'
        : `诊断完成：${successCount}/${checks.length} 项通过；请保留服务端日志，不要以单项成功作为 Sprint 1 结论。`,
      successCount === checks.length ? 'status-ok' : 'status-error',
    );
    button.disabled = false;
    button.textContent = '重新开始无凭据诊断';
  }

  window.openChamberHarmonyPocHostReady = function () {
    setText('host-callback', 'ArkTS 已通过 runJavaScript 发送回调', 'status-ok');
  };

  setText('href', window.location.href);
  setText('origin', window.location.origin || '(empty origin)');
  readBridge();
  document.getElementById('run-probe').addEventListener('click', function () {
    void runProbe();
  });
})();
