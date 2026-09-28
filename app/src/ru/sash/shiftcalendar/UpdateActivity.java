package ru.sash.mechaniccheck;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Manual, opt-in installer. Never reads/writes schedules, WebView data or app preferences. */
public final class UpdateActivity extends Activity {
    private static final int PERMISSION_REQUEST = 41, INSTALL_REQUEST = 42;
    // Serial publication, including across replacement Activity instances; no background service.
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private TextView installedView, status, notes;
    private Button primary, recheck;
    private ProgressBar progress;
    private Runnable action;
    private UpdatePolicy.Release release;
    private volatile Job active;
    private boolean destroyed, resumed, busy, ready;

    private static final class Job {
        volatile boolean cancelled;
        volatile HttpsURLConnection connection;
        final long deadline = SystemClock.elapsedRealtime() + 180000;
        boolean stopped() { return cancelled || Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() > deadline; }
        void ensure() throws IOException { if (stopped()) throw new IOException("Операция отменена или превышено время ожидания."); }
        void cancel() { cancelled = true; HttpsURLConnection c = connection; if (c != null) c.disconnect(); }
    }
    private static final class UpdateError extends IOException {
        UpdateError(String message) { super(message); }
    }
    private interface Work { Runnable run(Job job) throws Exception; }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("Обновление приложения");
        getWindow().setStatusBarColor(Color.rgb(244, 246, 250));
        getWindow().setNavigationBarColor(Color.rgb(244, 246, 250));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(244, 246, 250));
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            scroll.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else scroll.setFitsSystemWindows(true);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(20), dp(16), dp(20), dp(24));
        scroll.addView(body, new ScrollView.LayoutParams(-1, -2));
        Button back = button("Назад к графику", body);
        back.setOnClickListener(v -> finish());
        text("Обновление приложения", 25, body);
        installedView = text("", 16, body);
        text("Проверка выполняется только при открытии этого экрана или по кнопке. Для обновления нужен интернет. Графики и профили сохраняются; удалять приложение не нужно.", 16, body);
        status = text("", 18, body);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        progress = new ProgressBar(this);
        progress.setContentDescription("Выполняется проверка или загрузка обновления");
        body.addView(progress, new LinearLayout.LayoutParams(-2, -2));
        notes = text("", 16, body);
        primary = button("Проверить обновления", body);
        primary.setOnClickListener(v -> { if (!busy && action != null) action.run(); });
        recheck = button("Проверить снова", body);
        recheck.setOnClickListener(v -> check());
        setContentView(scroll);
        scroll.requestApplyInsets();
        showInstalled();
        check();
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size, LinearLayout body) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(28, 36, 52));
        view.setPadding(0, dp(10), 0, dp(10));
        body.addView(view, new LinearLayout.LayoutParams(-1, -2));
        return view;
    }
    private Button button(String label, LinearLayout body) {
        Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setMinHeight(dp(48));
        body.addView(b, new LinearLayout.LayoutParams(-1, -2)); return b;
    }
    private void offer(String message, String label, Runnable next) {
        status.setText(message); primary.setText(label); action = next;
        primary.setEnabled(true); recheck.setEnabled(true); progress.setVisibility(View.GONE);
    }
    private void showInstalled() {
        try { PackageInfo p = installed(); installedView.setText("Установлена версия: " + p.versionName + " (" + code(p) + ")"); }
        catch (Exception e) { installedView.setText("Не удалось прочитать установленную версию."); }
    }
    private void run(String message, Work work) {
        if (active != null) active.cancel();
        Job job = new Job(); active = job;
        busy = true; status.setText(message); primary.setEnabled(false); recheck.setEnabled(false); progress.setVisibility(View.VISIBLE);
        IO.execute(() -> {
            try {
                job.ensure();
                Runnable success = work.run(job);
                job.ensure();
                main.post(() -> {
                    if (!current(job)) return;
                    busy = false; progress.setVisibility(View.GONE); recheck.setEnabled(true);
                    success.run();
                });
            } catch (Exception e) {
                String detail = friendly(e);
                main.post(() -> {
                    if (!current(job)) return;
                    busy = false; ready = false;
                    offer(detail + "\nВаши графики доступны без интернета.", release == null ? "Повторить проверку" : "Повторить загрузку",
                            release == null ? this::check : this::download);
                });
            } finally {
                HttpsURLConnection c = job.connection;
                if (c != null) { c.disconnect(); job.connection = null; }
            }
        });
    }
    private boolean current(Job job) { return !destroyed && !isFinishing() && active == job && !job.cancelled; }
    private String friendly(Exception e) {
        if (e instanceof UpdateError || e instanceof UpdatePolicy.PolicyException) return e.getMessage();
        if (e instanceof javax.net.ssl.SSLException) return "Не удалось безопасно соединиться с сервером. Проверка сертификата не пройдена; проверьте дату и время устройства.";
        if (e instanceof java.net.UnknownHostException || e instanceof java.net.ConnectException || e instanceof java.net.SocketTimeoutException)
            return "Сервер обновлений недоступен. Проверьте подключение к интернету и попробуйте снова.";
        return "Не удалось получить или проверить обновление. Проверьте интернет и свободное место, затем повторите попытку.";
    }
    private void check() {
        release = null; ready = false; notes.setText(""); showInstalled();
        run("Проверяем наличие обновлений…", job -> {
            UpdatePolicy.Release found = fetchRelease(job);
            long installedCode = code(installed());
            if (!UpdatePolicy.isNewer(found, installedCode)) return () -> offer("У вас установлена последняя доступная версия.", "Проверить обновления", this::check);
            UpdatePolicy.requireSupported(found, Build.VERSION.SDK_INT);
            return () -> {
                release = found;
                notes.setText("Версия " + found.versionName + "\nРазмер: " + ((found.size + 1023) / 1024) + " КБ\n\nИзменения:\n" + (found.notes.trim().isEmpty() ? "Описание не указано." : found.notes));
                offer("Доступно обновление. Загрузка начнётся только после нажатия кнопки.", "Загрузить обновление", this::download);
            };
        });
    }
    private void download() {
        final UpdatePolicy.Release requested = release;
        if (requested == null) { check(); return; }
        ready = false;
        run("Загружаем и проверяем обновление…", job -> {
            File dir = UpdateProvider.directory(this);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new UpdateError("Не удалось создать папку для обновления. Проверьте свободное место.");
            // Only remove abandoned temp files; keep a complete APK an installer may still be reading.
            File[] stale = dir.listFiles((d, name) -> name.startsWith("download-") && name.endsWith(".part"));
            if (stale != null) for (File file : stale) file.delete();
            File temp = File.createTempFile("download-", ".part", dir);
            try {
                HttpsURLConnection connection = open(UpdatePolicy.apkUrl(requested.apk), job, UpdatePolicy.MAX_APK_BYTES);
                long length = connection.getContentLengthLong();
                if (length >= 0 && length != requested.size) throw new UpdateError("Размер файла на сервере не совпадает с описанием. Попробуйте проверить обновления позже.");
                try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(temp)) {
                    try { UpdatePolicy.copyVerified(in, out, requested, job::stopped); }
                    catch (IOException e) { throw new UpdateError("Загрузка не завершена или контрольная сумма/размер файла не совпадают. Повторите загрузку."); }
                    out.getFD().sync();
                }
                connection.disconnect(); job.connection = null;
                verifyArchive(temp, requested);
                job.ensure();
                synchronized (UpdateProvider.FILE_LOCK) {
                    job.ensure();
                    // Same directory/filesystem: rename replaces atomically, never exposes a partial APK.
                    if (!temp.renameTo(UpdateProvider.apkFile(this))) throw new UpdateError("Не удалось сохранить проверенное обновление. Попробуйте снова.");
                }
                return () -> { ready = true; showReady("Файл загружен. Размер, контрольная сумма и подпись проверены."); };
            } finally { temp.delete(); }
        });
    }
    private boolean installAllowed() { return getPackageManager().canRequestPackageInstalls(); }
    private void showReady(String message) {
        if (installAllowed()) offer(message + "\nУстановку нужно подтвердить в системном окне Android.", "Установить обновление", this::prepareInstaller);
        else offer(message + "\nAndroid требует разрешить установку из этого приложения. Разрешение можно отменить позже в настройках.", "Разрешить установку", this::openPermission);
    }
    private void openPermission() {
        try {
            startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + UpdatePolicy.PACKAGE)), PERMISSION_REQUEST);
        } catch (ActivityNotFoundException | SecurityException e) {
            offer("Не удалось открыть настройки. Разрешите установку для «Мой график» в настройках Android и вернитесь сюда.", "Проверить разрешение", () -> showReady("Проверка разрешения Android."));
        }
    }
    private void prepareInstaller() {
        if (!ready || release == null) { download(); return; }
        if (!installAllowed()) { showReady("Разрешение на установку не предоставлено."); return; }
        final UpdatePolicy.Release requested = release;
        run("Повторно проверяем файл перед установкой…", job -> {
            synchronized (UpdateProvider.FILE_LOCK) {
                File apk = UpdateProvider.apkFile(this);
                try (InputStream in = new FileInputStream(apk)) {
                    try { UpdatePolicy.copyVerified(in, new OutputStream() {
                        @Override public void write(int b) { }
                        @Override public void write(byte[] b, int off, int len) { }
                    }, requested, job::stopped); }
                    catch (IOException e) { throw new UpdateError("Сохранённый файл отсутствует или изменился. Загрузите обновление снова."); }
                }
                verifyArchive(apk, requested);
            }
            return () -> {
                // Never pop an installer over another app after the user leaves this screen.
                if (!resumed) { showReady("Файл проверен. Нажмите кнопку, чтобы продолжить установку."); return; }
                launchInstaller();
            };
        });
    }
    private void launchInstaller() {
        if (!installAllowed()) { showReady("Разрешение на установку не предоставлено."); return; }
        Uri uri = Uri.parse(UpdatePolicy.CONTENT_URI);
        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        intent.setDataAndType(uri, UpdateProvider.MIME);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("Обновление приложения", uri));
        intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
        try {
            startActivityForResult(intent, INSTALL_REQUEST);
            showReady("Подтвердите установку в окне Android. При отмене можно повторить попытку.");
        } catch (ActivityNotFoundException | SecurityException e) {
            showReady("Android не разрешил открыть установщик. Проверьте ограничения устройства и разрешение на установку.");
        }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PERMISSION_REQUEST) {
            if (ready && release != null) showReady(installAllowed() ? "Разрешение получено. Для установки нажмите кнопку ниже." : "Разрешение не предоставлено. Без него установка невозможна.");
            else if (!busy) offer("Вернулись из настроек. Проверьте обновления, чтобы продолжить.", "Проверить обновления", this::check);
        } else if (request == INSTALL_REQUEST) {
            showInstalled();
            try {
                if (release != null && code(installed()) >= release.versionCode) {
                    ready = false; release = null;
                    offer("Обновление установлено. Ваши графики сохранены.", "Проверить обновления", this::check);
                    return;
                }
            } catch (Exception ignored) { }
            if (ready && release != null) showReady(result == RESULT_CANCELED ? "Установка отменена или не завершена. Можно повторить попытку." : "Android не завершил установку. Можно повторить попытку.");
            else if (!busy) offer("Установка не подтверждена. Проверьте установленную версию и повторите проверку.", "Проверить обновления", this::check);
        }
    }
    @Override protected void onResume() { super.onResume(); resumed = true; }
    @Override protected void onPause() { resumed = false; super.onPause(); }
    @Override protected void onStop() {
        if (busy && active != null) {
            active.cancel(); busy = false;
            if (ready && release != null) showReady("Проверка перед установкой прервана. Можно повторить попытку.");
            else offer("Проверка или загрузка прервана при выходе с экрана. Можно повторить попытку.", release == null ? "Повторить проверку" : "Повторить загрузку", release == null ? this::check : this::download);
        }
        super.onStop();
    }
    @Override protected void onDestroy() {
        destroyed = true; if (active != null) active.cancel(); main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
    private PackageInfo installed() throws PackageManager.NameNotFoundException {
        return getPackageManager().getPackageInfo(UpdatePolicy.PACKAGE, signingFlags());
    }
    private int signingFlags() { // Android 9 getPackageArchiveInfo collects certs only when GET_SIGNATURES is also set.
        // Still compare the full current signingInfo signer set on API 28+, never lineage.
        return PackageManager.GET_SIGNATURES | (Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : 0); }
    private long code(PackageInfo p) { return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode; }
    private byte[][] signers(PackageInfo p) {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28 ? (p.signingInfo == null ? null : p.signingInfo.getApkContentsSigners()) : p.signatures;
        if (signatures == null) return null;
        byte[][] bytes = new byte[signatures.length][];
        for (int i = 0; i < signatures.length; i++) bytes[i] = signatures[i] == null ? null : signatures[i].toByteArray();
        return bytes;
    }
    private void verifyArchive(File file, UpdatePolicy.Release expected) throws Exception {
        PackageInfo archive = getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), signingFlags());
        if (archive == null || archive.applicationInfo == null) throw new UpdateError("Android не распознал файл обновления или не смог проверить его подпись.");
        PackageInfo current = installed();
        // Exact current signer set, not historical signing lineage: rotation is deliberately rejected.
        UpdatePolicy.validateArchive(expected, archive.packageName, code(archive), archive.applicationInfo.minSdkVersion,
                Build.VERSION.SDK_INT, code(current), signers(current), signers(archive));
    }
    private HttpsURLConnection open(URL url, Job job, long maxBytes) throws Exception {
        // Defense in depth: callers may only use the constant manifest URL or a whitelisted basename.
        String address = url.toExternalForm();
        if (!UpdatePolicy.ENDPOINT.equals(address)) {
            if (!UpdatePolicy.isApkUrl(address))
                throw new UpdateError("Недопустимый адрес обновления.");
        }
        job.ensure();
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
        job.connection = c;
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        c.setUseCaches(false); c.setRequestMethod("GET");
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Accept", UpdatePolicy.ENDPOINT.equals(address) ? "application/json" : UpdateProvider.MIME);
        // Default Android TLS trust and hostname verification. No custom trust manager/verifier.
        job.ensure();
        int response = c.getResponseCode();
        job.ensure();
        if (response >= 300 && response < 400) throw new UpdateError("Сервер перенаправляет запрос. Для безопасности обновление отклонено.");
        if (response != 200) throw new UpdateError("Сервер обновлений временно недоступен (код " + response + "). Попробуйте позже.");
        String encoding = c.getContentEncoding();
        if (encoding != null && !"identity".equalsIgnoreCase(encoding)) throw new UpdateError("Неподдерживаемое сжатие ответа сервера.");
        long size = c.getContentLengthLong();
        if (size > maxBytes) throw new UpdateError("Ответ сервера превышает допустимый размер.");
        return c;
    }
    private UpdatePolicy.Release fetchRelease(Job job) throws Exception {
        HttpsURLConnection c = open(new URL(UpdatePolicy.ENDPOINT), job, UpdatePolicy.MAX_JSON_BYTES);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream in = c.getInputStream()) {
            byte[] buffer = new byte[4096];
            while (true) {
                job.ensure();
                int n = in.read(buffer);
                if (n == -1) break;
                if (bytes.size() + n > UpdatePolicy.MAX_JSON_BYTES) throw new UpdateError("Описание обновления превышает допустимый размер.");
                bytes.write(buffer, 0, n);
            }
        } finally { c.disconnect(); job.connection = null; }
        job.ensure();
        try {
            String json = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
            JSONTokener tokener = new JSONTokener(json);
            Object value = tokener.nextValue();
            if (!(value instanceof JSONObject) || tokener.nextClean() != 0) throw new IllegalArgumentException();
            JSONObject obj = (JSONObject) value;
            long min = integer(obj, "minSdk");
            if (min <= 0 || min > Integer.MAX_VALUE) throw new IllegalArgumentException();
            return new UpdatePolicy.Release(integer(obj, "schema"), string(obj, "packageName"), integer(obj, "versionCode"),
                    string(obj, "versionName"), (int) min, string(obj, "apk"), string(obj, "sha256"), integer(obj, "size"), string(obj, "notes"));
        } catch (Exception e) { throw new UpdateError("Сервер вернул некорректное описание обновления. Попробуйте позже."); }
    }
    private static long integer(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new IllegalArgumentException();
        return ((Number) value).longValue();
    }
    private static String string(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof String)) throw new IllegalArgumentException();
        return (String) value;
    }
}
