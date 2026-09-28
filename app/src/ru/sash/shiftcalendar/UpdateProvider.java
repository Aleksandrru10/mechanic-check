package ru.sash.mechaniccheck;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/** Manifest: exported=false, grantUriPermissions=true. Never exposes arbitrary cache paths. */
public final class UpdateProvider extends ContentProvider {
    public static final String MIME = "application/vnd.android.package-archive";
    static final Object FILE_LOCK = new Object();
    @Override public boolean onCreate() { return true; }

    static File directory(Context context) throws IOException {
        File dir = new File(context.getCacheDir().getCanonicalFile(), "updates");
        if (!dir.equals(dir.getCanonicalFile())) throw new IOException("Недопустимое расположение файла обновления.");
        return dir;
    }
    static File apkFile(Context context) throws IOException {
        File file = new File(directory(context), "update.apk");
        if (!file.equals(file.getCanonicalFile())) throw new IOException("Недопустимое расположение файла обновления.");
        return file;
    }
    private static void checkUri(Uri uri) {
        if (uri == null || !UpdatePolicy.allowedProviderUri(uri.toString())) throw new IllegalArgumentException("Недопустимый адрес файла обновления.");
    }
    private File readableFile() throws FileNotFoundException {
        try {
            File f = apkFile(getContext());
            if (!f.isFile() || f.length() <= 0 || f.length() > UpdatePolicy.MAX_APK_BYTES) throw new IOException();
            return f;
        } catch (IOException e) { throw new FileNotFoundException("Файл обновления отсутствует. Загрузите его снова."); }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        checkUri(uri);
        if (!UpdatePolicy.readOnlyMode(mode)) throw new SecurityException("Разрешено только чтение обновления.");
        synchronized (FILE_LOCK) { return ParcelFileDescriptor.open(readableFile(), ParcelFileDescriptor.MODE_READ_ONLY); }
    }
    @Override public String getType(Uri uri) { checkUri(uri); return MIME; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        checkUri(uri);
        if (selection != null || args != null || sortOrder != null) throw new IllegalArgumentException("Параметры запроса не поддерживаются.");
        String[] columns = projection == null ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        Object[] values = new Object[columns.length];
        synchronized (FILE_LOCK) {
            File file;
            try { file = readableFile(); }
            catch (FileNotFoundException e) { throw new IllegalArgumentException(e.getMessage()); }
            for (int i = 0; i < columns.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) values[i] = "Обновление Моего графика.apk";
                else if (OpenableColumns.SIZE.equals(columns[i])) values[i] = file.length();
                else throw new IllegalArgumentException("Запрошено неподдерживаемое поле.");
            }
        }
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        cursor.addRow(values);
        return cursor;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw readOnly(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw readOnly(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw readOnly(); }
    private SecurityException readOnly() { return new SecurityException("Изменение файла обновления запрещено."); }
}
