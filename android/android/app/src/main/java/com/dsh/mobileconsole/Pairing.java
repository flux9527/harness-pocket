package com.dsh.mobileconsole;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/**
 * 配对信息（服务端地址 + 令牌）的持久化。
 *
 * 配对地址的形态是 {@code http://192.168.1.5:8799/?k=<32位令牌>}，由电脑上的
 * {@code /mobile url} 输出。后台服务是原生的，读不到 WebView 的 localStorage，
 * 所以必须落在 SharedPreferences 里。
 */
public final class Pairing {

    private static final String PREFS = "dsh_mobile_console";
    private static final String KEY_URL = "pairing_url";
    private static final String KEY_BASE = "base";
    private static final String KEY_TOKEN = "token";

    private Pairing() {}

    /** 解析后的配对信息。 */
    public static final class Parsed {
        public final String base;
        public final String token;

        Parsed(String base, String token) {
            this.base = base;
            this.token = token;
        }
    }

    /**
     * 从配对地址里拆出服务端根地址与令牌。
     *
     * @param raw 用户粘贴的地址
     * @return 解析结果；地址不合法或没有令牌时返回 null
     */
    public static Parsed parse(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty()) return null;
        // 允许用户只粘贴 "192.168.1.5:8799/?k=..." 这种省略协议的写法。
        if (!text.matches("(?i)^https?://.*")) text = "http://" + text;

        URI uri;
        try {
            uri = new URI(text);
        } catch (Exception error) {
            return null;
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;

        int port = uri.getPort();
        String scheme = uri.getScheme() == null ? "http" : uri.getScheme();
        String base = scheme + "://" + host + (port > 0 ? ":" + port : "");

        String token = null;
        String query = uri.getRawQuery();
        if (query != null) {
            for (String pair : query.split("&")) {
                int split = pair.indexOf('=');
                if (split <= 0) continue;
                if (!"k".equals(pair.substring(0, split))) continue;
                try {
                    token = URLDecoder.decode(pair.substring(split + 1), StandardCharsets.UTF_8.name());
                } catch (Exception error) {
                    token = pair.substring(split + 1);
                }
                break;
            }
        }
        if (token == null || token.isEmpty()) return null;
        return new Parsed(base, token);
    }

    /**
     * 保存配对信息。
     *
     * @param context 上下文
     * @param raw 原始配对地址
     * @return 解析结果；失败返回 null
     */
    public static Parsed save(Context context, String raw) {
        Parsed parsed = parse(raw);
        if (parsed == null) return null;
        prefs(context).edit()
                .putString(KEY_URL, raw.trim())
                .putString(KEY_BASE, parsed.base)
                .putString(KEY_TOKEN, parsed.token)
                .apply();
        return parsed;
    }

    /** @return 原始配对地址，未配对时为空串 */
    public static String url(Context context) {
        return prefs(context).getString(KEY_URL, "");
    }

    /** @return 服务端根地址，未配对时为空串 */
    public static String base(Context context) {
        return prefs(context).getString(KEY_BASE, "");
    }

    /** @return 令牌，未配对时为空串 */
    public static String token(Context context) {
        return prefs(context).getString(KEY_TOKEN, "");
    }

    /** @return 是否已经配对 */
    public static boolean isPaired(Context context) {
        return !base(context).isEmpty() && !token(context).isEmpty();
    }

    /**
     * 控制台页面地址（服务端根地址 + 令牌），供 WebView 加载。
     *
     * @param context 上下文
     * @return 地址；未配对时为空串
     */
    public static String consoleUrl(Context context) {
        String base = base(context);
        String token = token(context);
        if (base.isEmpty() || token.isEmpty()) return "";
        return base + "/?k=" + token;
    }

    /** 清除配对信息。 */
    public static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    /**
     * 给应用内 WebView 用的控制台地址：多带一个 {@code mcapp=1} 标记。
     *
     * 页面看到这个标记就知道自己跑在应用里，于是显示「返回应用」按钮——
     * 在普通浏览器里打开时不该出现那个按钮（那里没有"应用主页面"可回）。
     * 实现在 {@link #consoleUrl} 之后单独一个方法，是为了让两种场景各用各的、不互相污染。
     *
     * @param context 上下文
     * @return 地址；未配对时为空串
     */
    public static String consoleUrlForApp(Context context) {
        String url = consoleUrl(context);
        if (url.isEmpty()) return "";
        return url + "&mcapp=1";
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
