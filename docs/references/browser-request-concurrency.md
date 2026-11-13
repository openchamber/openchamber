# Browser request concurrency

Primary-source research checked on 2026-11-13. Source defaults describe the cited revisions. Release builds, platform networking, policies, and experiments can differ.

## HTTP/1.1 connections

- **Chrome/Chromium:** the normal pool defaults to **6 sockets per connection group**. The group includes the destination scheme/host/port and security/privacy partition information, including the network anonymization key. The pool is selected by proxy chain. "6 per origin" is practical shorthand for ordinary same-context direct requests, not a per-tab or browser-wide quota. [1]
- **Edge:** desktop Chromium-based Edge has the same upstream baseline. **6 is a common expectation derived from Chromium**, not an independently verified limit for every Edge build. No Edge measurement was performed here.
- **Firefox:** the default is **6 persistent connections per server**. Its preferences also allow **3 extra connections for urgent-start requests** and a separate **32-connection proxy default**, so 6 is not an absolute ceiling for all request classes or proxy configurations. [2]
- **Safari/WebKit:** Apple's networking API documents a default of **6 HTTP/1.1 connections per host per URLSession**, allows a lower effective limit, and explicitly excludes HTTP/2 and later from that property. **This does not verify the exact current Safari browser cap.** Safari/OS configuration and WebKit ports must not be collapsed into a universal six-request claim. [3]

These numbers count connections. An ordinary non-pipelined HTTP/1.1 request occupies its connection until its response body finishes, including streaming responses. Other tabs can compete within the same connection group; separate privacy/security partitions can have separate groups. [1, 4]

## HTTP/2 and HTTP/3 streams

When these browsers negotiate HTTP/2 or HTTP/3, multiple request streams share a connection. The HTTP/1.1 socket budget does not specify their request concurrency.

- **HTTP/2:** the server's `SETTINGS_MAX_CONCURRENT_STREAMS` limits client-created streams per connection. The setting is directional, so the browser's advertised receive limit is not the server's request allowance. RFC 9113 defines no initial protocol limit and recommends advertising at least 100. That recommendation is not a universal fixed browser limit. Browser admission policy, server settings, flow control, and resource constraints affect effective concurrency. [4]
- **HTTP/3:** each request uses a client-initiated bidirectional QUIC stream. The peer grants stream-opening credit through initial transport parameters and later `MAX_STREAMS` frames. Credit is cumulative and can be replenished as streams close. HTTP/3 recommends permitting at least 100 request streams, without imposing a universal concurrent-request number. Its limit mechanism is QUIC stream credit, not HTTP/2's setting. [5]

Connection reuse can cover multiple origins when authority requirements permit it. Reverse proxies can use different protocols on the browser-facing and upstream connections. Count actual negotiated connections and streams within their security context. [4, 5]

## Persistent responses and OpenChamber

An HTTP/1.1 SSE response occupies a connection for its lifetime. The HTML standard warns that multiple same-domain `EventSource` objects across pages can exhaust connection capacity and suggests sharing one through a shared worker. On HTTP/2 or HTTP/3, each persistent response occupies a multiplexed request stream. NDJSON retains its connection or stream until its response body finishes too. [4, 5, 6]

The reported OpenChamber workload launches more than 20 Git-status fetches while search shares its HTTP/1.1 connection group. This can fill the socket budget and queue search before the server receives it. Source research establishes that mechanism, not the exact application trace or browser queue fairness.

The NDJSON design separates **2 concurrent browser batch requests** from **4 concurrent server-side Git operations**. Those are application budgets at different layers. The smaller browser budget reduces socket pressure; it does not reserve search capacity against unrelated traffic. Browser scheduler permits must cover the full streamed response lifetime, including cancellation cleanup. These are design consequences, not measured proof of the implementation.

## Local measurement

An isolated Chrome run produced this result:

```json
{"browser":"Chrome/157.0.8103.52","protocol":"HTTP/1.1","origin":"localhost","requested":12,"reachedServerWhileHeld":6}
```

A page issued 12 simultaneous `/hold?i=...` fetches to a Node HTTP/1.1 server on an ephemeral localhost port. All responses stayed open. After 750 ms, 6 requests had reached the server. There were no existing auth/SSE connections. The run used the repository CDP helper with anti-throttling flags and closed the browser and server afterward.

This confirms the local Chrome dispatch count only. It does not measure Edge, Firefox, Safari, HTTP/2, HTTP/3, SSE contention, or the batching fix. Deployment diagnosis still needs the actual browser-facing protocol and queued-request timings.

## Primary sources

1. Chromium [`client_socket_pool_manager.cc`, revision `493dd686b4f2b8ba94c73b6c7806b7ce8dd989e7`](https://github.com/chromium/chromium/blob/493dd686b4f2b8ba94c73b6c7806b7ce8dd989e7/net/socket/client_socket_pool_manager.cc#L44-L66), six-socket default; [lines 103 to 117](https://github.com/chromium/chromium/blob/493dd686b4f2b8ba94c73b6c7806b7ce8dd989e7/net/socket/client_socket_pool_manager.cc#L103-L117), group key and proxy pool selection.
2. Mozilla [`all.js`, revision `2e185039d9be31b6a60f9c002144e7ee0dd22762`, lines 1138 to 1150](https://github.com/mozilla-firefox/firefox/blob/2e185039d9be31b6a60f9c002144e7ee0dd22762/modules/libpref/init/all.js#L1138-L1150), server, urgent-start, and proxy defaults.
3. Apple [`httpMaximumConnectionsPerHost`](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/httpmaximumconnectionsperhost), HTTP/1.1 default and per-session scope; HTTP/2 and later ignore the property. Moving official documentation.
4. IETF RFC 9113, [section 5.1.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.1.2), stream concurrency; [section 6.5.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-6.5.2), directional setting; [section 5.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.2), flow control; [section 9.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-9.1), connection reuse. Its introduction also explains HTTP/1.1 concurrency and pipelining limitations.
5. IETF RFC 9114, [section 6.1](https://www.rfc-editor.org/rfc/rfc9114.html#section-6.1), request streams, stream-credit references, and recommended parallelism; [section 3.3](https://www.rfc-editor.org/rfc/rfc9114.html#section-3.3), connection reuse. Its normative QUIC reference is RFC 9000, section 4.6, which defines cumulative `MAX_STREAMS` credit.
6. WHATWG HTML [server-sent events, authoring notes](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes), connection-limit warning and shared-worker guidance. Living standard.
