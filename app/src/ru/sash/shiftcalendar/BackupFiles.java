package ru.sash.mechaniccheck;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** SAF transport only. No bridge, storage permission, retained grant, or calendar mutation. */
final class BackupFiles {
    private static final int EXPORT_REQUEST = 7101, IMPORT_REQUEST = 7102;
    private static final String SAVED_OPERATION = "backup.pending.operation";
    private static final int PREPARING = 1, READY = 2, PICKING = 3, IO = 4;
    private static final long IO_TIMEOUT_MS = 120000;
    private final Activity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "calendar-backup-io");
        thread.setDaemon(true);
        return thread;
    });
    private Job active;
    private boolean destroyed, ready, resumed;
    private String interruptedOperation;

    private static final class Job {
        final boolean exporting;
        final CancellationSignal signal = new CancellationSignal();
        volatile boolean cancelled;
        volatile ParcelFileDescriptor descriptor;
        Future<?> future;
        Runnable timeout;
        int phase;
        byte[] bytes;
        Job(boolean exporting) { this.exporting = exporting; }
        void ensure() throws IOException {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("Операция отменена.");
        }
        void cancel() {
            cancelled = true;
            if (future != null) future.cancel(true);
            // A provider's remote cancellation may block; never do it on the UI thread.
            Thread cancellation = new Thread(() -> {
                ParcelFileDescriptor open = descriptor;
                if (open != null) {
                    try { open.closeWithError("Backup cancelled"); } catch (Exception ignored) { }
                }
                try { signal.cancel(); } catch (RuntimeException ignored) { }
            }, "calendar-backup-cancel");
            cancellation.setDaemon(true);
            cancellation.start();
            bytes = null;
        }
    }
    private interface Work { Runnable run() throws Exception; }

    BackupFiles(Activity activity, WebView web, Bundle state) {
        this.activity = activity;
        this.web = web;
        interruptedOperation = state == null ? null : state.getString(SAVED_OPERATION);
    }

    private boolean trusted() { return !destroyed && BackupPolicy.INDEX.equals(web.getUrl()); }
    private boolean current(Job job) { return !destroyed && active == job && !job.cancelled; }

    /** Called only by an explicit main-frame request, then checked again on the UI thread. */
    void start(String target) {
        if (!trusted() || !ready || !resumed || !BackupPolicy.isCommand(target, true, web.getUrl())) return;
        boolean exporting = BackupPolicy.EXPORT.equals(target);
        if (active != null) {
            // Do not emit a false completion for the operation that is still in progress.
            Toast.makeText(activity, "Дождитесь завершения операции с файлом.", Toast.LENGTH_SHORT).show();
            return;
        }
        Job job = new Job(exporting);
        active = job;
        if (!exporting) { showPicker(job); return; }
        job.phase = PREPARING;
        armTimeout(job);
        web.evaluateJavascript("(function(){try{return window.BackupUI.exportJSON();}catch(e){return null;}})()", value -> {
            if (!current(job)) return;
            work(job, () -> {
                job.ensure();
                // evaluateJavascript returns a JSON-encoded string, NOT the string's raw contents.
                if (value == null || value.length() < 2 || value.length() > BackupPolicy.MAX_BYTES * 6L + 2
                        || value.charAt(0) != '"' || value.charAt(value.length() - 1) != '"')
                    throw new IOException("Не удалось подготовить резервную копию.");
                JSONTokener parser = new JSONTokener(value);
                Object decoded = parser.nextValue();
                if (!(decoded instanceof String) || parser.nextClean() != 0)
                    throw new IOException("Не удалось прочитать данные резервной копии.");
                byte[] bytes = BackupPolicy.encode((String) decoded);
                job.ensure();
                return () -> {
                    job.bytes = bytes;
                    job.phase = READY;
                    if (resumed) showPicker(job);
                };
            });
        });
    }

    private void showPicker(Job job) {
        if (!current(job)) return;
        if (!trusted()) { fail(job, "Операция отменена: страница приложения изменилась."); return; }
        disarmTimeout(job);
        Intent intent = new Intent(job.exporting ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        if (job.exporting) {
            intent.setType("application/json");
            intent.putExtra(Intent.EXTRA_TITLE, "Мой-график-" + new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date()) + ".json");
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } else {
            // Some Android 8 providers label downloaded JSON text/plain or octet-stream.
            // Accept any openable document, then enforce byte/UTF-8/schema limits rather than MIME.
            intent.setType("*/*");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        job.phase = PICKING;
        try {
            activity.startActivityForResult(intent, job.exporting ? EXPORT_REQUEST : IMPORT_REQUEST);
        } catch (ActivityNotFoundException e) {
            fail(job, "На устройстве нет приложения для выбора документов.");
        } catch (RuntimeException e) {
            fail(job, "Не удалось открыть выбор файла.");
        }
    }

    boolean onActivityResult(int request, int result, Intent data) {
        if (request != EXPORT_REQUEST && request != IMPORT_REQUEST) return false;
        Job job = active;
        // Old picker results after recreation/reload never resume or create a new operation.
        if (job == null || job.phase != PICKING || job.exporting != (request == EXPORT_REQUEST)) return true;
        if (result != Activity.RESULT_OK) {
            fail(job, job.exporting ? "Сохранение резервной копии отменено." : "Выбор резервной копии отменён.");
            return true;
        }
        Uri uri;
        try { uri = data == null ? null : data.getData(); }
        catch (RuntimeException e) { fail(job, "Не удалось прочитать выбранный файл."); return true; }
        if (uri == null || !BackupPolicy.isContentUri(uri.toString())) {
            fail(job, "Выберите документ через системный выбор файлов (content URI).");
            return true;
        }
        if (!trusted()) { fail(job, "Операция отменена: страница приложения изменилась."); return true; }
        job.phase = IO;
        if (job.exporting) {
            final byte[] bytes = job.bytes;
            job.bytes = null;
            if (bytes == null) { fail(job, "Сохранение отменено: данные копии недоступны."); return true; }
            work(job, () -> {
                write(job, uri, bytes);
                return () -> finish(job, "onExportResult", "true," + quote("Резервная копия сохранена."), "Резервная копия сохранена.");
            });
        } else {
            work(job, () -> {
                String text = read(job, uri);
                // Only delivers a preview. BackupUI validates and explicitly confirms before applying.
                String argument = quote(text);
                return () -> finish(job, "receiveImport", argument, "Не удалось показать резервную копию. Данные приложения не изменены.");
            });
        }
        return true;
    }

    private ParcelFileDescriptor open(Job job, Uri uri, String mode) throws IOException {
        job.ensure();
        ParcelFileDescriptor descriptor = activity.getContentResolver().openFileDescriptor(uri, mode, job.signal);
        if (descriptor == null) throw new IOException("Поставщик документов не открыл файл.");
        job.descriptor = descriptor;
        return descriptor;
    }

    private String read(Job job, Uri uri) throws Exception {
        ParcelFileDescriptor descriptor = open(job, uri, "r");
        try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            job.ensure();
            String text = BackupPolicy.read(input);
            job.ensure();
            if (descriptor.canDetectErrors()) descriptor.checkError();
            return text;
        }
    }

    private void write(Job job, Uri uri, byte[] bytes) throws Exception {
        ParcelFileDescriptor descriptor = open(job, uri, "wt");
        // AutoCloseOutputStream closes both the stream and its owning ParcelFileDescriptor.
        try (ParcelFileDescriptor.AutoCloseOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
            try {
                job.ensure();
                BackupPolicy.write(output, bytes);
                // fsync is mandatory for real files, but invalid on SAF streaming/pipe providers.
                if (OsConstants.S_ISREG(Os.fstat(descriptor.getFileDescriptor()).st_mode))
                    descriptor.getFileDescriptor().sync();
                job.ensure();
                if (descriptor.canDetectErrors()) descriptor.checkError();
            } catch (Exception e) {
                // Tell reliable-pipe providers the document is incomplete, where supported.
                try { descriptor.closeWithError("Backup write failed or cancelled"); }
                catch (IOException ignored) { }
                throw e;
            }
        }
        // Reached only after flush, applicable fsync AND successful close; never claim partial writes.
        job.ensure();
    }

    private void armTimeout(Job job) {
        disarmTimeout(job);
        job.timeout = () -> {
            if (!current(job)) return;
            fail(job, job.exporting ? "Время сохранения истекло. Файл может быть неполным; повторите экспорт." : "Время чтения истекло. Данные приложения не изменены.");
            job.cancel();
        };
        main.postDelayed(job.timeout, IO_TIMEOUT_MS);
    }
    private void disarmTimeout(Job job) {
        if (job.timeout != null) main.removeCallbacks(job.timeout);
        job.timeout = null;
    }
    private void work(Job job, Work task) {
        if (!current(job)) return;
        armTimeout(job);
        job.future = executor.submit(() -> {
            try {
                job.ensure();
                Runnable result = task.run();
                job.ensure();
                main.post(() -> {
                    if (current(job)) { disarmTimeout(job); result.run(); }
                });
            } catch (Exception e) {
                main.post(() -> {
                    if (current(job)) fail(job, job.exporting
                        ? "Не удалось сохранить резервную копию. Проверьте доступ и свободное место; файл может быть неполным."
                        : "Не удалось прочитать резервную копию. Нужен доступный файл UTF-8 не больше 2 МиБ. Данные приложения не изменены.");
                });
            }
        });
    }
    private void fail(Job job, String message) {
        finish(job, job.exporting ? "onExportResult" : "onImportError", (job.exporting ? "false," : "") + quote(message), message);
    }
    private void finish(Job job, String method, String arguments, String fallback) {
        if (!current(job)) return;
        disarmTimeout(job);
        active = null;
        job.bytes = null;
        if (ready && trusted()) send(method, arguments, fallback);
        else interruptedOperation = job.exporting ? "export" : "import";
    }
    private static String quote(String text) {
        return JSONObject.quote(text).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }
    private void send(String method, String arguments, String fallback) {
        if (!trusted()) return;
        web.evaluateJavascript("(function(){try{if(window.BackupUI&&typeof window.BackupUI." + method
            + "==='function'){window.BackupUI." + method + "(" + arguments + ");return true;}}catch(e){}return false;})()", result -> {
                if (trusted() && !"true".equals(result)) Toast.makeText(activity, fallback, Toast.LENGTH_LONG).show();
            });
    }
    void onPageStarted() {
        ready = false;
        if (active != null) {
            interruptedOperation = active.exporting ? "export" : "import";
            disarmTimeout(active);
            active.cancel();
            active = null;
        }
    }
    void onPageFinished(String url) {
        ready = BackupPolicy.INDEX.equals(url) && trusted();
        if (!ready || interruptedOperation == null) return;
        boolean exporting = "export".equals(interruptedOperation);
        interruptedOperation = null;
        String message = exporting
            ? "Сохранение отменено после перезапуска экрана. Выбранный файл может быть неполным; повторите экспорт."
            : "Импорт отменён после перезапуска экрана. Данные приложения не изменены; выберите файл снова.";
        send(exporting ? "onExportResult" : "onImportError", (exporting ? "false," : "") + quote(message), message);
    }
    void onResume() {
        resumed = true;
        if (active != null && active.exporting && active.phase == READY) showPicker(active);
    }
    void onPause() { resumed = false; }
    void saveState(Bundle state) {
        String operation = active == null ? interruptedOperation : active.exporting ? "export" : "import";
        if (operation != null) state.putString(SAVED_OPERATION, operation);
        // Never put exported schedules/import text in Binder's size-limited instance-state Bundle.
    }
    void destroy() {
        destroyed = true;
        if (active != null) { active.cancel(); active = null; }
        main.removeCallbacksAndMessages(null);
        executor.shutdownNow();
    }
}
