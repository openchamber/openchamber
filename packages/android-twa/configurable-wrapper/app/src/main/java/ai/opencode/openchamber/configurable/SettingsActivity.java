package ai.opencode.openchamber.configurable;

import android.content.Intent;
import android.content.SharedPreferences;
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

import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;

public class SettingsActivity extends AppCompatActivity {

    private AutoCompleteTextView urlInput;
    private Button connectButton;
    private Button clearButton;
    private TextView errorText;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        prefs = getSharedPreferences(App.PREFS_NAME, MODE_PRIVATE);

        urlInput = findViewById(R.id.url_input);
        connectButton = findViewById(R.id.connect_button);
        clearButton = findViewById(R.id.clear_button);
        errorText = findViewById(R.id.error_text);

        String savedUrl = prefs.getString(App.KEY_SERVER_URL, "");
        if (!savedUrl.isEmpty()) {
            urlInput.setText(savedUrl);
        } else {
            urlInput.setHint(getString(R.string.url_hint));
        }

        setupUrlHistory();
        setupButtons();
        setupValidation();
    }

    private void setupUrlHistory() {
        String historyStr = prefs.getString(App.KEY_URL_HISTORY, "");
        List<String> history = new ArrayList<>();
        if (!historyStr.isEmpty()) {
            history.addAll(Arrays.asList(historyStr.split("\\|")));
        }
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_dropdown_item_1line, history);
        urlInput.setAdapter(adapter);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setThreshold(1);
    }

    private void setupButtons() {
        connectButton.setOnClickListener(v -> {
            String url = urlInput.getText().toString().trim();
            if (isValidUrl(url)) {
                saveUrl(url);
                Intent intent = new Intent(SettingsActivity.this, MainActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                startActivity(intent);
                finish();
            } else {
                errorText.setVisibility(View.VISIBLE);
                errorText.setText(R.string.invalid_url);
            }
        });

        clearButton.setOnClickListener(v -> {
            prefs.edit().remove(App.KEY_SERVER_URL).apply();
            urlInput.setText("");
            errorText.setVisibility(View.GONE);
        });
    }

    private void setupValidation() {
        urlInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

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
        return url.startsWith("http://") || url.startsWith("https://");
    }

    private void saveUrl(String url) {
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString(App.KEY_SERVER_URL, url);

        String historyStr = prefs.getString(App.KEY_URL_HISTORY, "");
        List<String> history = new ArrayList<>();
        if (!historyStr.isEmpty()) {
            history.addAll(Arrays.asList(historyStr.split("\\|")));
        }
        history.remove(url);
        history.add(0, url);
        if (history.size() > App.MAX_HISTORY) {
            history = history.subList(0, App.MAX_HISTORY);
        }
        editor.putString(App.KEY_URL_HISTORY, String.join("|", history));
        editor.apply();
    }
}
