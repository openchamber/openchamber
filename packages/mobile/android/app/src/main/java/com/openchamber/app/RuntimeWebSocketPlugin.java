package com.openchamber.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONArray;

@CapacitorPlugin(name = "RuntimeWebSocket")
public class RuntimeWebSocketPlugin extends Plugin {
    // Redirects must not carry proxy credentials to another address.
    private final OkHttpClient client = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).build();
    private final Map<String, WebSocket> sockets = new HashMap<>();
    private final Set<String> opened = new HashSet<>();

    private void emit(String id, String type, JSObject data) {
        data.put("id", id);
        data.put("type", type);
        notifyListeners("socketEvent", data);
    }

    @PluginMethod
    public synchronized void open(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url", "");
        if (id == null || sockets.containsKey(id) || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
            call.reject("Invalid WebSocket request");
            return;
        }
        try {
            Request.Builder request = new Request.Builder().url(url);
            JSObject headers = call.getObject("headers", new JSObject());
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                request.header(name, headers.getString(name));
            }
            // Use the packaged client's allowlisted origin, independent of the WebView URL.
            request.header("Origin", "https://localhost");
            JSONArray protocols = call.getArray("protocols");
            if (protocols != null && protocols.length() > 0) {
                String[] values = new String[protocols.length()];
                for (int i = 0; i < values.length; i++) values[i] = protocols.getString(i);
                request.header("Sec-WebSocket-Protocol", String.join(", ", values));
            }
            WebSocket socket = client.newWebSocket(request.build(), new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) {
                    synchronized (RuntimeWebSocketPlugin.this) {
                        if (sockets.get(id) != ws) { ws.cancel(); return; }
                        opened.add(id);
                        emit(id, "open", new JSObject());
                    }
                }
                @Override public void onMessage(WebSocket ws, String text) {
                    message(ws, text, false);
                }
                @Override public void onMessage(WebSocket ws, ByteString bytes) {
                    message(ws, bytes.base64(), true);
                }
                private void message(WebSocket ws, String data, boolean binary) {
                    synchronized (RuntimeWebSocketPlugin.this) {
                        if (sockets.get(id) != ws) return;
                        JSObject event = new JSObject();
                        event.put("data", data);
                        event.put("binary", binary);
                        emit(id, "message", event);
                    }
                }
                @Override public void onClosing(WebSocket ws, int code, String reason) {
                    ws.close(code, reason);
                }
                @Override public void onClosed(WebSocket ws, int code, String reason) {
                    synchronized (RuntimeWebSocketPlugin.this) {
                        if (!sockets.remove(id, ws)) return;
                        opened.remove(id);
                        emitClose(id, code, reason);
                    }
                }
                @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                    synchronized (RuntimeWebSocketPlugin.this) {
                        if (!sockets.remove(id, ws)) return;
                        opened.remove(id);
                        // Native errors can include credential-bearing URLs. Keep them local.
                        emit(id, "error", new JSObject());
                        emitClose(id, 1006, "");
                    }
                }
            });
            sockets.put(id, socket);
            call.resolve();
        } catch (Exception error) {
            call.reject("Invalid WebSocket request");
        }
    }

    @PluginMethod
    public synchronized void send(PluginCall call) {
        WebSocket socket = sockets.get(call.getString("id"));
        String data = call.getString("data");
        if (socket == null || data == null) { call.reject("WebSocket is closed"); return; }
        boolean accepted;
        if (Boolean.TRUE.equals(call.getBoolean("binary", false))) {
            ByteString bytes = ByteString.decodeBase64(data);
            if (bytes == null) { call.reject("Invalid binary frame"); return; }
            accepted = socket.send(bytes);
        } else {
            accepted = socket.send(data);
        }
        if (accepted) call.resolve();
        else call.reject("WebSocket send failed");
    }

    private void emitClose(String id, int code, String reason) {
        JSObject event = new JSObject();
        event.put("code", code);
        event.put("reason", reason);
        emit(id, "close", event);
    }

    @PluginMethod
    public synchronized void close(PluginCall call) {
        String id = call.getString("id");
        WebSocket socket = sockets.remove(id);
        if (socket != null) {
            // Removing the socket also cancels a handshake that has not opened yet.
            int code = call.getInt("code", 1000);
            String reason = call.getString("reason", "");
            try {
                if (opened.remove(id)) socket.close(code, reason);
                else socket.cancel();
            }
            catch (IllegalArgumentException error) { socket.cancel(); }
            // Bound cleanup even if the peer never acknowledges the close.
            getBridge().getWebView().postDelayed(socket::cancel, 5000);
            emitClose(id, code, reason);
        }
        call.resolve();
    }

    @Override protected synchronized void handleOnDestroy() {
        for (WebSocket socket : sockets.values()) socket.cancel();
        sockets.clear();
        opened.clear();
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }
}
