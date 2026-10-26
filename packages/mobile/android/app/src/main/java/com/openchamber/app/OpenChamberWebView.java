package com.openchamber.app;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.AttributeSet;
import android.util.Base64;
import android.util.Log;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputContentInfo;
import android.view.inputmethod.InputMethodManager;
import androidx.annotation.RequiresApi;
import com.getcapacitor.CapacitorWebView;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lets the IME paste an image into the page. A WebView declares no content types, so Gboard
 * refuses an image paste outright and never fires a paste event; declaring image content on
 * the EditorInfo makes it offer one, and {@link ImageCommitConnection} hands what it commits
 * to the page. Only the composer takes it, which the page reports through ImagePastePlugin.
 */
public class OpenChamberWebView extends CapacitorWebView {

    private static final String TAG = "OpenChamberWebView";

    /** Must match IMAGE_PASTE_EVENT in nativeImagePaste.ts. */
    private static final String IMAGE_PASTE_EVENT = "openchamber-native-image-paste";

    private static final int FIRST_CONTENT_INSERTION_API = Build.VERSION_CODES.N_MR1;

    /** A bridge guard, not a product limit: desktop and the picker accept any size. */
    private static final int MAX_IMAGE_BYTES = 64 * 1024 * 1024;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService imageReader = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "openchamber-image-paste");
        thread.setDaemon(true);
        return thread;
    });

    private volatile boolean imagePasteEnabled = true;

    public OpenChamberWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        // The bridge looks this WebView up by an id defined in Capacitor's own layout.
        setId(com.getcapacitor.android.R.id.webview);
    }

    /** Returns the previous value, so the caller can tell whether the IME saw this state. */
    public boolean setImagePasteEnabled(boolean enabled) {
        boolean previous = imagePasteEnabled;
        imagePasteEnabled = enabled;
        return previous;
    }

    /** Makes the IME read the EditorInfo again, which it otherwise only does on focus. */
    public void restartInputConnection() {
        InputMethodManager manager = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (manager != null) {
            manager.restartInput(this);
        }
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection delegate = super.onCreateInputConnection(outAttrs);
        if (Build.VERSION.SDK_INT < FIRST_CONTENT_INSERTION_API || delegate == null) {
            return delegate;
        }
        if (!imagePasteEnabled) {
            return delegate;
        }
        // After super, so nothing the WebView writes into outAttrs can clear it.
        outAttrs.contentMimeTypes = new String[] { "image/*" };
        return new ImageCommitConnection(delegate);
    }

    /**
     * Its own class because it names {@link InputContentInfo}, which API 24 lacks. Only
     * onCreateInputConnection constructs one, and only after the version check.
     */
    @RequiresApi(FIRST_CONTENT_INSERTION_API)
    private final class ImageCommitConnection extends InputConnectionWrapper {

        ImageCommitConnection(InputConnection target) {
            super(target, true);
        }

        @Override
        public boolean commitContent(InputContentInfo contentInfo, int flags, Bundle opts) {
            forwardImage(contentInfo);
            // Delegating would ask the IME to retry against an editor that cannot accept it.
            return true;
        }

        private void forwardImage(InputContentInfo contentInfo) {
            Uri contentUri = contentInfo.getContentUri();
            contentInfo.requestPermission();
            imageReader.execute(() -> postToPage(readImage(contentUri, contentInfo)));
        }

        /** The page event detail for the committed image, whether it worked or why it did not. */
        private String readImage(Uri contentUri, InputContentInfo contentInfo) {
            try (InputStream stream = getContext().getContentResolver().openInputStream(contentUri)) {
                if (stream == null) {
                    return failure("unreadable");
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                String mimeType = null;
                int total = 0;
                int read;
                while ((read = stream.read(chunk)) != -1) {
                    if (mimeType == null) {
                        mimeType = sniffImageType(chunk, read);
                    }
                    total += read;
                    if (total > MAX_IMAGE_BYTES) {
                        Log.w(TAG, "Refusing a committed image over " + MAX_IMAGE_BYTES + " bytes");
                        return failure("too-large");
                    }
                    buffer.write(chunk, 0, read);
                }
                if (mimeType == null) {
                    return failure("unsupported-type");
                }
                String data = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
                return "{\"ok\":true,\"mimeType\":\"" + mimeType + "\",\"data\":\"" + data + "\"}";
            } catch (IOException | SecurityException error) {
                Log.w(TAG, "Could not read the image the IME committed", error);
                return failure("unreadable");
            } finally {
                contentInfo.releasePermission();
            }
        }

        /** From the bytes, not the clipboard description: whichever app copied in declares that, and
         *  nothing ties it to what the provider serves. Covers what the pipeline accepts. */
        private static String sniffImageType(byte[] head, int length) {
            if (length >= 8 && u8(head[0]) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G'
                && u8(head[4]) == 0x0D && u8(head[5]) == 0x0A && u8(head[6]) == 0x1A && u8(head[7]) == 0x0A) {
                return "image/png";
            }
            if (length >= 3 && u8(head[0]) == 0xFF && u8(head[1]) == 0xD8 && u8(head[2]) == 0xFF) {
                return "image/jpeg";
            }
            if (length >= 4 && head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8') {
                return "image/gif";
            }
            if (length >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') {
                return "image/webp";
            }
            // ISO base media file format: "ftyp" then a brand, which is how HEIC identifies.
            if (length >= 12 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p'
                && matchesHeicBrand(head, 8)) {
                return "image/heic";
            }
            return null;
        }

        private static boolean matchesHeicBrand(byte[] head, int at) {
            String brand = new String(head, at, 4, java.nio.charset.StandardCharsets.US_ASCII);
            return brand.equals("heic") || brand.equals("heix") || brand.equals("hevc") || brand.equals("mif1");
        }

        private static int u8(byte value) {
            return value & 0xFF;
        }

        private static String failure(String reason) {
            return "{\"ok\":false,\"reason\":\"" + reason + "\"}";
        }

        /** The detail is machine-built: base64 and a media type this class chose, so neither can
         *  close the literal or the string around them. */
        private void postToPage(String detail) {
            mainHandler.post(() -> evaluateJavascript(
                "window.dispatchEvent(new CustomEvent(\"" + IMAGE_PASTE_EVENT + "\", { detail: " + detail + " }))",
                null
            ));
        }
    }
}
