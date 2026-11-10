package com.openchamber.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Owns transient audio focus for one reading, including WebView speech and Web Audio. */
@CapacitorPlugin(name = "ReadingAudioFocus")
public class ReadingAudioFocusPlugin extends Plugin {
    private AudioManager audioManager;
    private AudioFocusRequest request;
    private AudioManager.OnAudioFocusChangeListener listener;
    private String ownerId;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @PluginMethod
    public void acquire(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("A reading id is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            abandon();
            if (audioManager == null) {
                resolveGranted(call, false);
                return;
            }
            ownerId = id;
            listener = change -> {
                if (!id.equals(ownerId)) return;
                String state;
                if (change == AudioManager.AUDIOFOCUS_GAIN) {
                    state = "gained";
                } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                    || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                    state = "paused";
                } else if (change == AudioManager.AUDIOFOCUS_LOSS) {
                    state = "lost";
                    abandon();
                } else {
                    return;
                }
                JSObject event = new JSObject();
                event.put("id", id);
                event.put("state", state);
                notifyListeners("focusChanged", event);
            };
            int result;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                    .setWillPauseWhenDucked(true)
                    .setOnAudioFocusChangeListener(listener)
                    .build();
                result = audioManager.requestAudioFocus(request);
            } else {
                result = audioManager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
            }
            boolean granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            if (!granted) abandon();
            resolveGranted(call, granted);
        });
    }

    @PluginMethod
    public void release(PluginCall call) {
        String id = call.getString("id");
        getActivity().runOnUiThread(() -> {
            if (id != null && id.equals(ownerId)) abandon();
            call.resolve();
        });
    }

    private void resolveGranted(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private void abandon() {
        ownerId = null;
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) {
                audioManager.abandonAudioFocusRequest(request);
            } else if (listener != null) {
                audioManager.abandonAudioFocus(listener);
            }
        }
        request = null;
        listener = null;
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(this::abandon);
    }
}
