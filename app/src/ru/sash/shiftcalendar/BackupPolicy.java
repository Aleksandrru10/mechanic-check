package ru.sash.mechaniccheck;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Android-independent transport limits. JSON schema/confirmation belong to BackupUI. */
public final class BackupPolicy {
    public static final int MAX_BYTES = 2 * 1024 * 1024;
    public static final String INDEX = "https://appassets.androidplatform.net/index.html";
    public static final String EXPORT = "https://appassets.androidplatform.net/backup-export";
    public static final String IMPORT = "https://appassets.androidplatform.net/backup-import";
    private BackupPolicy() { }

    public static boolean isCommand(String target, boolean mainFrame, String current) {
        return mainFrame && INDEX.equals(current) && (EXPORT.equals(target) || IMPORT.equals(target));
    }

    /** No file/network/opaque URI, user-info, ports, empty provider, or URI fragments. */
    public static boolean isContentUri(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            String authority = uri.getRawAuthority();
            return "content".equals(uri.getScheme()) && !uri.isOpaque()
                && authority != null && authority.matches("[A-Za-z0-9_][A-Za-z0-9_.-]*")
                && uri.getRawFragment() == null && uri.getRawPath() != null
                && uri.getRawPath().startsWith("/") && uri.getRawPath().length() > 1;
        } catch (URISyntaxException e) { return false; }
    }

    public static byte[] encode(String text) throws IOException {
        if (text == null || text.length() > MAX_BYTES) throw tooLarge();
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(text));
            if (encoded.remaining() > MAX_BYTES) throw tooLarge();
            byte[] bytes = new byte[encoded.remaining()];
            encoded.get(bytes);
            return bytes;
        } catch (CharacterCodingException e) { throw new IOException("Некорректный текст UTF-8.", e); }
    }

    /** Reads at most MAX_BYTES + 1; never trusts a provider's size or available(). Does not own input. */
    public static String read(InputStream input) throws IOException {
        if (input == null) throw new IOException("Не удалось открыть файл.");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        while (true) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Чтение отменено.");
            int count = input.read(buffer, 0, Math.min(buffer.length, MAX_BYTES - total + 1));
            if (count < 0) break;
            // Defend against broken providers/streams that return zero without reaching EOF.
            if (count == 0) {
                int next = input.read();
                if (next < 0) break;
                buffer[0] = (byte) next;
                count = 1;
            }
            total += count;
            if (total > MAX_BYTES) throw tooLarge();
            output.write(buffer, 0, count);
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(output.toByteArray())).toString();
        } catch (CharacterCodingException e) { throw new IOException("Файл должен содержать корректный UTF-8.", e); }
    }

    /** Caller owns close/fsync. Propagates partial-write and flush failures without claiming success. */
    public static void write(OutputStream output, byte[] bytes) throws IOException {
        if (output == null || bytes == null) throw new IOException("Нет данных для сохранения.");
        if (bytes.length > MAX_BYTES) throw tooLarge();
        for (int offset = 0; offset < bytes.length; offset += 8192) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Запись отменена.");
            output.write(bytes, offset, Math.min(8192, bytes.length - offset));
        }
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Запись отменена.");
        output.flush();
    }

    private static IOException tooLarge() { return new IOException("Резервная копия больше 2 МиБ."); }
}
