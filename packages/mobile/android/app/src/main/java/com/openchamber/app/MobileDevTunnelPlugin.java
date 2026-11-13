package com.openchamber.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * A loopback-only TCP listener per preview. Every byte goes to the trusted
 * renderer, which opens the authenticated /api/dev-tunnel WebSocket. No HTTP
 * or WebSocket traffic is parsed or rewritten here.
 */
@CapacitorPlugin(name = "MobileDevTunnel")
public class MobileDevTunnelPlugin extends Plugin {
    private static final int MAX_CONNECTIONS = 64;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final Map<String, ServerSocket> listeners = new HashMap<>();
    private final Map<String, Channel> connections = new HashMap<>();

    private final class Channel {
        final String tunnelId;
        final String id;
        final Socket socket;
        final Semaphore readCredit = new Semaphore(0);
        boolean closed = false;

        Channel(String tunnelId, Socket socket) {
            this.tunnelId = tunnelId;
            this.id = UUID.randomUUID().toString();
            this.socket = socket;
        }

        void read() {
            workers.execute(() -> {
                byte[] buffer = new byte[32 * 1024];
                try {
                    // The renderer must first establish the remote WebSocket.
                    if (!readCredit.tryAcquire(10, TimeUnit.SECONDS)) return;
                    while (!socket.isClosed()) {
                        int length = socket.getInputStream().read(buffer);
                        if (length < 0) return;
                        if (length == 0) continue;
                        JSObject event = new JSObject();
                        event.put("data", Base64.encodeToString(buffer, 0, length, Base64.NO_WRAP));
                        emit(tunnelId, id, "data", event);
                        // One outstanding read per connection bounds native -> JS memory.
                        readCredit.acquire();
                    }
                } catch (IOException | InterruptedException ignored) {
                    // Closing either side tears down the whole connection.
                } finally {
                    closeChannel(this);
                }
            });
        }
    }

    private String key(String tunnelId, String connectionId) {
        return tunnelId + "|" + connectionId;
    }

    private void emit(String tunnelId, String connectionId, String type, JSObject data) {
        data.put("id", tunnelId);
        data.put("connectionId", connectionId);
        data.put("type", type);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> notifyListeners("tunnelEvent", data));
        }
    }

    private synchronized void closeChannel(Channel channel) {
        if (channel.closed) return;
        channel.closed = true;
        channel.readCredit.release();
        connections.remove(key(channel.tunnelId, channel.id));
        try { channel.socket.close(); } catch (IOException ignored) {}
        emit(channel.tunnelId, channel.id, "close", new JSObject());
    }

    @PluginMethod
    public synchronized void start(PluginCall call) {
        String id = call.getString("id");
        if (id == null || listeners.containsKey(id)) {
            call.reject("Invalid dev tunnel");
            return;
        }
        try {
            ServerSocket server = new ServerSocket();
            server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), MAX_CONNECTIONS);
            listeners.put(id, server);
            workers.execute(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket socket = server.accept();
                        socket.setTcpNoDelay(true);
                        Channel channel;
                        synchronized (MobileDevTunnelPlugin.this) {
                            if (server.isClosed() || connections.size() >= MAX_CONNECTIONS) {
                                socket.close();
                                continue;
                            }
                            channel = new Channel(id, socket);
                            connections.put(key(id, channel.id), channel);
                        }
                        emit(id, channel.id, "connect", new JSObject());
                        channel.read();
                    } catch (IOException ignored) {
                        break;
                    }
                }
            });
            JSObject result = new JSObject();
            result.put("localPort", server.getLocalPort());
            call.resolve(result);
        } catch (IOException error) {
            call.reject("Cannot listen for dev-server preview");
        }
    }

    private synchronized Channel find(PluginCall call) {
        return connections.get(key(call.getString("id", ""), call.getString("connectionId", "")));
    }

    @PluginMethod
    public synchronized void ready(PluginCall call) {
        Channel channel = find(call);
        if (channel != null && !channel.closed) channel.readCredit.release();
        call.resolve();
    }

    @PluginMethod
    public synchronized void ack(PluginCall call) {
        Channel channel = find(call);
        if (channel != null && !channel.closed) channel.readCredit.release();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        Channel channel;
        synchronized (this) { channel = find(call); }
        String data = call.getString("data");
        if (channel == null || data == null) { call.reject("Dev tunnel closed"); return; }
        final byte[] bytes;
        try { bytes = Base64.decode(data, Base64.DEFAULT); }
        catch (IllegalArgumentException error) { call.reject("Invalid tunnel bytes"); return; }
        workers.execute(() -> {
            try {
                synchronized (channel) {
                    channel.socket.getOutputStream().write(bytes);
                }
                call.resolve();
            } catch (IOException error) {
                closeChannel(channel);
                call.reject("Dev tunnel closed");
            }
        });
    }

    @PluginMethod
    public synchronized void close(PluginCall call) {
        Channel channel = find(call);
        if (channel != null) closeChannel(channel);
        call.resolve();
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        String id = call.getString("id");
        ServerSocket listener = listeners.remove(id);
        if (listener != null) {
            try { listener.close(); } catch (IOException ignored) {}
        }
        for (Channel channel : connections.values().toArray(new Channel[0])) {
            if (channel.tunnelId.equals(id)) closeChannel(channel);
        }
        call.resolve();
    }

    @Override
    protected synchronized void handleOnDestroy() {
        for (ServerSocket server : listeners.values()) {
            try { server.close(); } catch (IOException ignored) {}
        }
        listeners.clear();
        for (Channel channel : connections.values().toArray(new Channel[0])) closeChannel(channel);
        workers.shutdownNow();
    }
}
