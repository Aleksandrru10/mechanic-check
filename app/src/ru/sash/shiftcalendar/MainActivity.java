package ru.sash.mechaniccheck;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Bitmap;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.net.Uri;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.util.HashMap;

/** Offline calendar: bundled assets, fixed native updater/SAF routes, and no JS bridge. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    private WebView web;
    private BackupFiles backups;
    private AvatarFiles avatars;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(244,246,250));
        getWindow().setNavigationBarColor(Color.rgb(244,246,250));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0));
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(20,25,24));
        applyTheme(false);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(20,25,24));
        WebSettings settings = web.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " ShiftCalendarAndroid");
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        web.setWebChromeClient(new WebChromeClient());
        backups = new BackupFiles(this, web, state);
        avatars = new AvatarFiles(this,web);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String target = req.getUrl().toString();
                if(req.isForMainFrame() && "GET".equals(req.getMethod()) && !req.isRedirect() && BackupPolicy.INDEX.equals(view.getUrl()) && (target.equals(ORIGIN+"theme-light") || target.equals(ORIGIN+"theme-dark"))) {applyTheme(target.endsWith("light"));return true;}
                if (req.isForMainFrame() && "GET".equals(req.getMethod()) && !req.isRedirect() && AvatarFiles.ROUTE.equals(target) && BackupPolicy.INDEX.equals(view.getUrl())) { avatars.start(); return true; }
                if ("GET".equals(req.getMethod()) && !req.isRedirect()
                        && BackupPolicy.isCommand(target, req.isForMainFrame(), view.getUrl())) {
                    runOnUiThread(() -> { if (backups != null) backups.start(target); });
                    return true;
                }
                if (req.isForMainFrame() && req.getUrl().toString().equals(ORIGIN + "check-updates")) {
                    startActivity(new Intent(MainActivity.this, UpdateActivity.class)); return true;
                }
                return !req.getUrl().toString().equals(ORIGIN + "index.html");
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // This legacy callback has no main-frame signal; never use it to launch SAF.
                if (url.equals(ORIGIN + "check-updates")) {
                    startActivity(new Intent(MainActivity.this, UpdateActivity.class)); return true;
                }
                return !url.equals(ORIGIN + "index.html");
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (backups != null) backups.onPageStarted();
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (backups != null) backups.onPageFinished(url);
                if(BackupPolicy.INDEX.equals(url))view.evaluateJavascript("document.body.classList.contains('light')",value->applyTheme("true".equals(value)));
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return asset(request.getUrl());
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
        root.requestApplyInsets();
        web.loadUrl(ORIGIN + "index.html");
    }
    private WebResourceResponse asset(Uri uri) {
        String path = uri.getPath();
        boolean allowed = "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) &&
            ("/index.html".equals(path) || "/schedule.js".equals(path) || "/profiles.js".equals(path) || "/money.js".equals(path) || "/app.js".equals(path) || "/mechanic.js".equals(path) || "/style.css".equals(path));
        if (allowed) {
            try {
                String mime = path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "application/javascript";
                HashMap<String,String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store");
                headers.put("X-Content-Type-Options", "nosniff");
                return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, getAssets().open(path.substring(1)));
            } catch (Exception ignored) { }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", new HashMap<String,String>(), new ByteArrayInputStream(new byte[0]));
    }
    @Override protected void onResume() {
        super.onResume();
        if (backups != null) backups.onResume();
    }
    @Override protected void onPause() {
        if (backups != null) backups.onPause();
        super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        if (backups != null) backups.saveState(state);
        super.onSaveInstanceState(state);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (avatars != null && avatars.result(request,result,data)) return;
        if (backups != null) backups.onActivityResult(request, result, data);
    }
    private void applyTheme(boolean light) {
        int color=light?Color.rgb(241,244,239):Color.rgb(20,25,24);getWindow().setStatusBarColor(color);getWindow().setNavigationBarColor(color);
        getWindow().getDecorView().setSystemUiVisibility(light?(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR):0);
    }
    @Override public void onBackPressed() {
        if(web!=null && BackupPolicy.INDEX.equals(web.getUrl())) {web.evaluateJavascript("Boolean(window.PremiumUI && window.PremiumUI.handleBack())",value->{if(!"true".equals(value))finish();});}else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        if (avatars != null) { avatars.destroy(); avatars = null; }
        if (backups != null) { backups.destroy(); backups = null; }
        if (web != null) { ((FrameLayout)web.getParent()).removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
}
