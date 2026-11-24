package br.com.atlasdamente;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintManager;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private static final int FILE_REQUEST = 1;
    private static final int CANVAS = 0xfff8f7fc;
    private static final int MINT = 0xffdbf3e8;
    private static final int INK = 0xff242035;
    private static final int PURPLE = 0xff6141c3;

    private SharedPreferences preferences;
    private FrameLayout content;
    private WebView web;
    private EditText serverField;
    private TextView feedback;
    private Button connectButton;
    private ValueCallback<Uri[]> fileUpload;
    private String origin;
    private int attempt;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("atlas-settings", MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(CANVAS);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            }
            return insets;
        });

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), 0, dp(9), 0);
        TextView title = text("Atlas da Mente", 19, INK);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        Button menu = button("Menu", false);
        menu.setOnClickListener(this::showMenu);
        header.addView(menu);
        root.addView(header, new LinearLayout.LayoutParams(-1, dp(54)));

        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);

        String saved = preferences.getString("origin", "");
        showSettings("");
        if (!saved.isEmpty()) connect(saved);
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private Button button(String label, boolean primary) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextColor(primary ? 0xffffffff : PURPLE);
        if (primary) view.setBackground(rounded(PURPLE, 9));
        view.setMinHeight(dp(44));
        return view;
    }

    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        return shape;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        if (origin != null) menu.getMenu().add("Início");
        if (web != null && web.isShown()) menu.getMenu().add("Imprimir página");
        menu.getMenu().add("Servidor");
        menu.setOnMenuItemClickListener(item -> {
            switch (item.getTitle().toString()) {
                case "Início":
                    attempt++;
                    openAtlas(origin);
                    break;
                case "Imprimir página":
                    printPage();
                    break;
                default:
                    showSettings("");
                    break;
            }
            return true;
        });
        menu.show();
    }

    private void showSettings(String message) {
        attempt++;
        content.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(18), dp(18), dp(18), dp(18));
        form.setBackground(rounded(MINT, 16));
        FrameLayout holder = new FrameLayout(this);
        holder.setPadding(dp(16), dp(18), dp(16), dp(18));
        holder.addView(form, new FrameLayout.LayoutParams(-1, -2));

        TextView heading = text("Conectar ao Atlas", 25, 0xff203b35);
        heading.setTypeface(null, android.graphics.Typeface.BOLD);
        form.addView(heading);
        TextView description = text("Informe o endereço do servidor Atlas. Use o mesmo endereço para acessar suas contas no computador e no celular.", 15, 0xff3a6258);
        description.setPadding(0, dp(8), 0, dp(15));
        form.addView(description);
        TextView label = text("Endereço do servidor", 14, INK);
        form.addView(label);

        serverField = new EditText(this);
        serverField.setId(View.generateViewId());
        label.setLabelFor(serverField.getId());
        serverField.setSingleLine(true);
        serverField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        serverField.setHint("https://atlas.exemplo.com");
        serverField.setText(preferences.getString("origin", ""));
        serverField.setSelectAllOnFocus(true);
        form.addView(serverField, new LinearLayout.LayoutParams(-1, -2));

        feedback = text(message, 14, 0xff9b3044);
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        feedback.setPadding(0, dp(5), 0, dp(10));
        form.addView(feedback);
        connectButton = button("Conectar", true);
        connectButton.setOnClickListener(view -> connect(serverField.getText().toString()));
        form.addView(connectButton, new LinearLayout.LayoutParams(-1, dp(46)));
        scroll.addView(holder);
        content.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
    }

    private void connect(String value) {
        final String address;
        try {
            address = ServerAddress.normalize(value);
        } catch (IllegalArgumentException exception) {
            feedback.setText(exception.getMessage());
            return;
        }
        final int current = ++attempt;
        connectButton.setEnabled(false);
        feedback.setText("Conectando…");

        new Thread(() -> {
            String problem = "";
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(address + "/api/session").openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(6000);
                connection.setReadTimeout(6000);
                try (InputStream body = connection.getInputStream()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] chunk = new byte[1024];
                    int count;
                    while ((count = body.read(chunk)) != -1) {
                        if (bytes.size() + count > 8192) throw new IllegalArgumentException();
                        bytes.write(chunk, 0, count);
                    }
                    JSONObject data = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
                    if (!data.has("account") || !(data.opt("demo") instanceof Boolean)) throw new IllegalArgumentException();
                    if (address.startsWith("http:") && !data.getBoolean("demo")) {
                        problem = "Use HTTPS para acessar uma instância com contas privadas.";
                    }
                }
            } catch (Exception exception) {
                problem = "Não foi possível conectar. Confira o endereço e a rede do servidor.";
            } finally {
                if (connection != null) connection.disconnect();
            }
            final String error = problem;
            runOnUiThread(() -> {
                if (current != attempt || isFinishing() || isDestroyed()) return;
                if (!error.isEmpty()) {
                    feedback.setText(error);
                    connectButton.setEnabled(true);
                    return;
                }
                preferences.edit().putString("origin", address).apply();
                openAtlas(address);
            });
        }, "atlas-connect").start();
    }

    private void openAtlas(String address) {
        content.removeAllViews();
        if (web != null) web.destroy();
        origin = address;
        web = new WebView(this);
        web.setBackgroundColor(CANVAS);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " AtlasAndroid/0.0.0");
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if ("atlas-print".equals(target.getScheme()) && request.isForMainFrame() && request.hasGesture()) {
                    printPage();
                    return true;
                }
                return !ServerAddress.sameOrigin(origin, target.toString());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && view == web) {
                    showSettings("Não foi possível abrir o Atlas. Confira o endereço do servidor.");
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> result, FileChooserParams params) {
                if (fileUpload != null) fileUpload.onReceiveValue(null);
                fileUpload = result;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("application/json");
                try {
                    startActivityForResult(picker, FILE_REQUEST);
                } catch (android.content.ActivityNotFoundException error) {
                    fileUpload = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> downloadQuestionnaire(url));
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(origin);
    }

    private void downloadQuestionnaire(String value) {
        if (!ServerAddress.sameOrigin(origin, value)) return;
        Uri url = Uri.parse(value);
        String targetPath = url.getPath();
        if (targetPath == null) return;
        String file = switch (targetPath) {
            case "/api/questionnaires/template" -> "atlas-modelo-questionario.json";
            default -> targetPath.matches("/api/questionnaires/q-[A-Za-z0-9_-]{24}/export")
                ? "atlas-" + url.getPathSegments().get(2) + ".json" : null;
        };
        if (file == null) return;
        DownloadManager.Request request = new DownloadManager.Request(url);
        String cookie = CookieManager.getInstance().getCookie(value);
        if (cookie != null) request.addRequestHeader("Cookie", cookie);
        request.setTitle(file)
            .setMimeType("application/json")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, file);
            } else {
                request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, file);
            }
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(request);
            Toast.makeText(this, "Download iniciado.", Toast.LENGTH_SHORT).show();
        } catch (RuntimeException error) {
            Toast.makeText(this, "Não foi possível iniciar o download.", Toast.LENGTH_SHORT).show();
        }
    }

    private void printPage() {
        if (web == null || !web.isShown()) return;
        PrintManager printer = (PrintManager) getSystemService(PRINT_SERVICE);
        printer.print("Atlas da Mente", web.createPrintDocumentAdapter("Atlas da Mente"), null);
    }

    @Override
    public void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != FILE_REQUEST || fileUpload == null) return;
        fileUpload.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null
            ? new Uri[] { data.getData() } : null);
        fileUpload = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.isShown() && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    public void onDestroy() {
        attempt++;
        if (fileUpload != null) fileUpload.onReceiveValue(null);
        if (web != null) {
            content.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
