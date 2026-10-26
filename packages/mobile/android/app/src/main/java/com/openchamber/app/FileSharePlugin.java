package com.openchamber.app;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Opens the Android share sheet for a file the web layer already holds.
 *
 * Android WebView implements neither the Web Share API nor blob downloads, so
 * "download" buttons in the app are silent without this. The file is written
 * to the cache directory, which the manifest's FileProvider already exposes.
 */
@CapacitorPlugin(name = "FileShare")
public class FileSharePlugin extends Plugin {

    private static final String SHARE_DIR = "shared-files";

    @PluginMethod
    public void share(PluginCall call) {
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String data = call.getString("data");
        if (fileName == null || data == null) {
            call.reject("fileName and data are required");
            return;
        }

        File directory = new File(getContext().getCacheDir(), SHARE_DIR);
        clearDirectory(directory);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            call.reject("Failed to prepare the share directory");
            return;
        }

        // Keep only the last path segment so a crafted name cannot escape the directory.
        String safeName = new File(fileName).getName();
        if (safeName.isEmpty()) {
            safeName = "file";
        }
        File file = new File(directory, safeName);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(Base64.decode(data, Base64.DEFAULT));
        } catch (IOException | IllegalArgumentException error) {
            call.reject("Failed to write the shared file", error);
            return;
        }

        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mimeType);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, safeName);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(chooser);
        call.resolve();
    }

    // One shared file at a time is enough; drop the previous one so the cache does not grow.
    private void clearDirectory(File directory) {
        File[] previous = directory.listFiles();
        if (previous == null) {
            return;
        }
        for (File entry : previous) {
            //noinspection ResultOfMethodCallIgnored
            entry.delete();
        }
    }
}
