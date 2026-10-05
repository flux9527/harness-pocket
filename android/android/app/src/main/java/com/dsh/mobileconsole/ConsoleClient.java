package com.dsh.mobileconsole;

import android.content.Context;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 和电脑上的 dsh-mobile-console 插件说话。
 *
 * 只用 {@link HttpURLConnection}：请求就两个字段，为它引一个 HTTP 库不划算，
 * 而且少一个依赖就少一处构建风险。所有方法都是阻塞的，必须在后台线程调用。
 */
public final class ConsoleClient {

    /** 单次请求的超时。局域网里不该慢，超时就当失败重试。 */
    private static final int TIMEOUT_MS = 15_000;

    private ConsoleClient() {}

    /**
     * 回答一条待办（审批的允许/拒绝，或提问的答案）。
     *
     * @param context 上下文
     * @param requestId 请求 id
     * @param decision {@code allow} 或 {@code deny}
     * @return 是否被插件接受
     */
    public static boolean answer(Context context, String requestId, String decision) {
        String body = "{\"requestId\":" + quote(requestId) + ",\"decision\":" + quote(decision) + "}";
        return post(context, "/api/answer", body);
    }

    /**
     * 向某个会话注入一条消息。
     *
     * @param context 上下文
     * @param sessionId 会话 id
     * @param text 内容
     * @return 是否被接受
     */
    public static boolean send(Context context, String sessionId, String text) {
        String body = "{\"sessionId\":" + quote(sessionId) + ",\"text\":" + quote(text) + "}";
        return post(context, "/api/send", body);
    }

    /**
     * 发一个 JSON POST。
     *
     * @param context 上下文
     * @param path 路径
     * @param body 请求体
     * @return 是否 2xx
     */
    private static boolean post(Context context, String path, String body) {
        String base = Pairing.base(context);
        String token = Pairing.token(context);
        if (base.isEmpty() || token.isEmpty()) {
            ServiceLog.w("没有配对信息，无法请求 " + path);
            return false;
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + path).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("X-MC-Token", token);
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(payload);
            }
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                ServiceLog.w(path + " -> HTTP " + code);
                return false;
            }
            return true;
        } catch (Exception error) {
            ServiceLog.w(path + " 请求失败：" + error);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * 把字符串包成 JSON 字面量。
     *
     * @param value 原值
     * @return JSON 字符串
     */
    private static String quote(String value) {
        if (value == null) return "null";
        StringBuilder builder = new StringBuilder(value.length() + 2);
        builder.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"': builder.append("\\\""); break;
                case '\\': builder.append("\\\\"); break;
                case '\n': builder.append("\\n"); break;
                case '\r': builder.append("\\r"); break;
                case '\t': builder.append("\\t"); break;
                default:
                    if (character < 0x20) builder.append(String.format("\\u%04x", (int) character));
                    else builder.append(character);
            }
        }
        builder.append('"');
        return builder.toString();
    }
}
