package com.openchamber.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The key this phone opens end-to-end sealed push text with. Made once and
 * kept in the app's private preferences; the web layer hands it to the server
 * with the push token (PushKeyPlugin), and the messaging service opens what
 * the server sealed. The relay and Google then carry only sealed text.
 *
 * Format of `enc`: "v1." + base64(nonce[12] || ciphertext || tag[16]),
 * AES-256-GCM, as the server's push-seal.js writes it.
 */
final class PushSealKey {

    private static final String PREFERENCES = "openchamber_push";
    private static final String KEY_NAME = "pushSealKey";
    private static final String SEAL_VERSION = "v1.";
    private static final int KEY_BYTES = 32;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;

    private PushSealKey() {}

    static synchronized String get(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String stored = preferences.getString(KEY_NAME, null);
        if (stored != null && decode(stored).length == KEY_BYTES) {
            return stored;
        }
        byte[] key = new byte[KEY_BYTES];
        new SecureRandom().nextBytes(key);
        String encoded = Base64.encodeToString(key, Base64.NO_WRAP);
        preferences.edit().putString(KEY_NAME, encoded).apply();
        return encoded;
    }

    /** The sealed JSON text, or null when it cannot be opened with this phone's key. */
    static String open(Context context, String sealed) {
        if (sealed == null || !sealed.startsWith(SEAL_VERSION)) return null;
        try {
            byte[] combined = decode(sealed.substring(SEAL_VERSION.length()));
            if (combined.length <= NONCE_BYTES + TAG_BITS / 8) return null;
            byte[] key = decode(get(context));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(combined, 0, NONCE_BYTES))
            );
            byte[] plaintext = cipher.doFinal(combined, NONCE_BYTES, combined.length - NONCE_BYTES);
            return new String(plaintext, StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }

    private static byte[] decode(String value) {
        try {
            return Base64.decode(value, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            return new byte[0];
        }
    }
}
