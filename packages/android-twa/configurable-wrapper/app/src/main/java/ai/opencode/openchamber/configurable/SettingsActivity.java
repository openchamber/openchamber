package ai.opencode.openchamber.configurable;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.Button;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.textfield.TextInputLayout;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class SettingsActivity extends AppCompatActivity {

    private TextInputLayout urlInputLayout;
    private AutoCompleteTextView urlInput;
    private Button connectButton;
    private Button clearButton;
    private TextView errorText;
    private SharedPreferences prefs;

    public static final String EXTRA_DEFAULT_URL_HINT = "default_url_hint";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        prefs = getSharedPreferences(App.PREFS_NAME, MODE_PRIVATE);

        urlInputLayout = findViewById(R.id.url_input_layout);
        urlInput = findViewById(R.id.url_input);
        connectButton = findViewById(R.id.connect_button);
        clearButton = findViewById(R.id.clear_button);
        errorText = findViewById(R.id.error_text);

        String savedUrl = prefs.getString(App.KEY_SERVER_URL, "");
        if (!savedUrl.isEmpty()) {
            urlInput.setText(savedUrl);
        } else {
            String hintUrl = getIntent().getStringExtra(EXTRA_DEFAULT_URL_HINT);
            if (hintUrl != null && !hintUrl.isEmpty()) {
                urlInputLayout.setHint(hintUrl);
            }
            // Default hint is already set via android:hint in XML
        }

        setupUrlHistory();
        setupButtons();
        setupValidation();
    }

    private void setupUrlHistory() {
        String historyStr = prefs.getString(App.KEY_URL_HISTORY, "");
        List<String> history = new ArrayList<>();
        if (!historyStr.isEmpty()) {
            try {
                JSONArray arr = new JSONArray(historyStr);
                for (int i = 0; i < arr.length(); i++) {
                    history.add(arr.getString(i));
                }
            } catch (JSONException e) {
                // Legacy pipe-delimited format - migrate
                history.addAll(Arrays.asList(historyStr.split("\\|")));
            }
        }
        ArrayAdapter<String> adapter =
                new ArrayAdapter<>(this, android.R.layout.simple_dropdown_item_1line, history);
        urlInput.setAdapter(adapter);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setThreshold(1);
    }

    private void setupButtons() {
        connectButton.setOnClickListener(
                v -> {
            String rawUrl = urlInput.getText().toString().trim();
            // Strip trailing slashes
            final String url = rawUrl.replaceAll("/+$", "");
                    // Reject control characters
                    if (url.matches(".*[\\x00-\\x1F\\x7F].*")) {
                        errorText.setVisibility(View.VISIBLE);
                        errorText.setText(R.string.invalid_url);
                        return;
                    }
                    urlInput.setText(url);
                    if (!isValidUrl(url)) {
                        if (errorText.getVisibility() != View.VISIBLE) {
                            errorText.setVisibility(View.VISIBLE);
                            errorText.setText(R.string.invalid_url);
                        }
                        return;
                    }
                    if (url.startsWith("http://") && !isLocalHost(Uri.parse(url).getHost())) {
                        new androidx.appcompat.app.AlertDialog.Builder(this)
                                .setTitle(R.string.http_warning_title)
                                .setMessage(R.string.http_warning_message)
                                .setPositiveButton(
                                        R.string.http_warning_accept,
                                        (d, w) -> connectToServer(url))
                                .setNegativeButton(android.R.string.cancel, null)
                                .show();
                    } else {
                        connectToServer(url);
                    }
                });

        clearButton.setOnClickListener(
                v -> {
                    prefs.edit().remove(App.KEY_SERVER_URL).apply();
                    urlInput.setText("");
                    errorText.setVisibility(View.GONE);
                });
    }

    private void setupValidation() {
        urlInput.addTextChangedListener(
                new TextWatcher() {
                    @Override
                    public void beforeTextChanged(
                            CharSequence s, int start, int count, int after) {}

                    @Override
                    public void onTextChanged(CharSequence s, int start, int before, int count) {
                        errorText.setVisibility(View.GONE);
                    }

                    @Override
                    public void afterTextChanged(Editable s) {}
                });
    }

    private boolean isValidUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
        Uri uri = Uri.parse(url);
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            errorText.setVisibility(View.VISIBLE);
            errorText.setText(R.string.invalid_url_detail);
            return false;
        }
        return true;
    }

    private boolean isLocalHost(String host) {
        return "localhost".equals(host) || "127.0.0.1".equals(host) || "10.0.2.2".equals(host);
    }

    private void connectToServer(String url) {
        saveUrl(url);
        Intent intent = new Intent(SettingsActivity.this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    private void saveUrl(String url) {
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString(App.KEY_SERVER_URL, url);

        String historyStr = prefs.getString(App.KEY_URL_HISTORY, "");
        List<String> history = new ArrayList<>();
        if (!historyStr.isEmpty()) {
            try {
                JSONArray arr = new JSONArray(historyStr);
                for (int i = 0; i < arr.length(); i++) {
                    history.add(arr.getString(i));
                }
            } catch (JSONException e) {
                // Legacy pipe-delimited format - migrate
                history.addAll(Arrays.asList(historyStr.split("\\|")));
            }
        }
        history.remove(url);
        history.add(0, url);
        if (history.size() > App.MAX_HISTORY) {
            history = history.subList(0, App.MAX_HISTORY);
        }
        JSONArray jsonHistory = new JSONArray(history);
        editor.putString(App.KEY_URL_HISTORY, jsonHistory.toString());
        editor.putInt(App.KEY_URL_HISTORY_VERSION, 2);
        editor.apply();
    }
}
