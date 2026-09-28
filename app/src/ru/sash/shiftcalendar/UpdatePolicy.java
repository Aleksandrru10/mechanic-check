package ru.sash.mechaniccheck;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/** Fail-closed rules shared by the native updater and plain-JVM tests. */
public final class UpdatePolicy {
    public static final String PACKAGE = "ru.sash.mechaniccheck";
    public static final String BASE = "https://raw.githubusercontent.com/Aleksandrru10/mechanic-check/master/";
    public static final String ENDPOINT = BASE + "latest.json";
    public static final String CONTENT_URI = "content://ru.sash.mechaniccheck.updates/update.apk";
    public static final long MAX_APK_BYTES = 50L * 1024 * 1024;
    public static final int MAX_JSON_BYTES = 64 * 1024;
    private static final Pattern APK = Pattern.compile("MechanicCheck-[0-9]+(?:\\.[0-9]+)*\\.apk");
    private static final Pattern SHA = Pattern.compile("[0-9a-f]{64}");
    private UpdatePolicy() { }
    /** Only these messages are safe to display directly; platform exception text may not be Russian. */
    public static final class PolicyException extends IllegalArgumentException {
        PolicyException(String message) { super(message); }
    }

    public static final class Release {
        public final long versionCode, size;
        public final int minSdk;
        public final String versionName, apk, sha256, notes;
        public Release(long schema, String packageName, long versionCode, String versionName,
                       int minSdk, String apk, String sha256, long size, String notes) {
            require(schema == 1 && PACKAGE.equals(packageName), "Сервер вернул описание другого приложения или неподдерживаемый формат.");
            require(versionCode > 0 && minSdk > 0, "В описании обновления неверная версия Android или приложения.");
            require(versionName != null && !versionName.trim().isEmpty() && versionName.length() <= 100,
                    "В описании обновления неверное название версии.");
            apkUrl(apk);
            require(sha256 != null && SHA.matcher(sha256).matches(), "В описании обновления неверная контрольная сумма.");
            require(size > 0 && size <= MAX_APK_BYTES, "Недопустимый размер обновления (максимум 50 МБ).");
            require(notes != null && notes.length() <= 12000, "Описание изменений слишком длинное или отсутствует.");
            this.versionCode = versionCode; this.versionName = versionName; this.minSdk = minSdk;
            this.apk = apk; this.sha256 = sha256; this.size = size; this.notes = notes;
        }
    }
    public static URL apkUrl(String basename) {
        require(basename != null && basename.length() <= 160 && APK.matcher(basename).matches(),
                "Недопустимый адрес файла обновления.");
        try { return new URL(BASE + basename); }
        catch (MalformedURLException e) { throw new IllegalArgumentException("Недопустимый адрес обновления.", e); }
    }
    /** Validates a complete raw GitHub APK URL without treating the repository path as a filename. */
    public static boolean isApkUrl(String address) {
        if (address == null || !address.startsWith(BASE)) return false;
        String basename = address.substring(BASE.length());
        try { return apkUrl(basename).toExternalForm().equals(address); }
        catch (RuntimeException rejected) { return false; }
    }
    public static boolean isNewer(Release r, long installed) { return r.versionCode > installed; }
    public static void requireSupported(Release r, int deviceSdk) {
        require(r.minSdk <= deviceSdk, "Для этой версии нужен более новый Android. Установленная версия продолжит работать.");
    }
    public static void validateArchive(Release r, String packageName, long versionCode, int minSdk,
                                       int deviceSdk, long installed, byte[][] currentSigners, byte[][] archiveSigners) {
        require(PACKAGE.equals(packageName), "Загруженный файл относится к другому приложению.");
        require(versionCode == r.versionCode && versionCode > installed, "Версия загруженного файла не совпадает с описанием или уже установлена.");
        requireSupported(r, deviceSdk);
        require(minSdk > 0 && minSdk <= deviceSdk, "Загруженное обновление несовместимо с вашей версией Android.");
        require(sameSigners(currentSigners, archiveSigners), "Подпись обновления не совпадает с установленным приложением. Установка отменена.");
    }
    public static boolean sameSigners(byte[][] a, byte[][] b) {
        if (a == null || b == null || a.length == 0 || a.length != b.length) return false;
        for (int i = 0; i < a.length; i++) {
            if (a[i] == null || a[i].length == 0 || b[i] == null || b[i].length == 0) return false;
            for (int j = 0; j < i; j++) if (Arrays.equals(a[i], a[j]) || Arrays.equals(b[i], b[j])) return false;
            boolean found = false;
            for (byte[] candidate : b) if (Arrays.equals(a[i], candidate)) { found = true; break; }
            if (!found) return false;
        }
        return true;
    }
    public static boolean allowedProviderUri(String uri) { return CONTENT_URI.equals(uri); }
    public static boolean readOnlyMode(String mode) { return "r".equals(mode); }

    /** Never publishes its output: caller must delete failed temp files, verify archive, then rename. */
    public static void copyVerified(InputStream in, OutputStream out, Release release, BooleanSupplier cancelled) throws IOException {
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IOException("Не удалось проверить контрольную сумму.", impossible); }
        long count = 0;
        byte[] buffer = new byte[32768];
        while (true) {
            if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new IOException("Загрузка отменена или превышено время ожидания.");
            int read = in.read(buffer);
            if (read == -1) break;
            count += read;
            if (count > release.size || count > MAX_APK_BYTES) throw new IOException("Размер файла больше указанного. Загрузка отменена.");
            digest.update(buffer, 0, read);
            out.write(buffer, 0, read);
        }
        if (cancelled.getAsBoolean() || Thread.currentThread().isInterrupted()) throw new IOException("Загрузка отменена или превышено время ожидания.");
        if (count != release.size) throw new IOException("Файл загружен не полностью. Попробуйте снова.");
        if (!hex(digest.digest()).equals(release.sha256)) throw new IOException("Контрольная сумма не совпадает. Файл не будет установлен.");
    }
    public static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) { int v = bytes[i] & 255; out[i * 2] = digits[v >>> 4]; out[i * 2 + 1] = digits[v & 15]; }
        return new String(out);
    }
    private static void require(boolean condition, String message) {
        if (!condition) throw new PolicyException(message);
    }
}
