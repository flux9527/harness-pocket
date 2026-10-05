package com.dsh.mobileconsole;

import android.app.NotificationManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 暴露给页面的原生能力。
 *
 * 除了配对读写，这里还提供两件"排查用"的东西——理由很直接：把 APK 装到手机上试的时候，
 * **没有任何办法看到发生了什么**，只能靠应用自己说。
 * <ul>
 *   <li>{@link #logs} / {@link #logsText} / {@link #clearLogs}：应用内日志；</li>
 *   <li>{@link #diagnose}：把「为什么通知不是灵动岛」逐条查清并给一句结论。</li>
 * </ul>
 */
@CapacitorPlugin(name = "Pairing")
public class PairingPlugin extends Plugin {

    /**
     * 保存配对地址并启动后台服务。
     *
     * @param call 调用
     */
    @PluginMethod
    public void save(PluginCall call) {
        String url = call.getString("url", "");
        ServiceLog.i("收到配对请求：" + url);
        Pairing.Parsed parsed = Pairing.save(getContext(), url);
        JSObject result = new JSObject();
        if (parsed == null) {
            ServiceLog.w("配对失败：地址里没找到令牌");
            result.put("ok", false);
            result.put("error", "这个地址里没找到令牌。请在电脑上执行 /mobile url，把输出的完整地址复制过来。");
            call.resolve(result);
            return;
        }
        ServiceLog.i("配对成功 base=" + parsed.base + " 令牌长度=" + parsed.token.length());
        ConsoleService.start(getContext());
        result.put("ok", true);
        result.put("base", parsed.base);
        result.put("running", true);
        call.resolve(result);
    }

    /**
     * 读取已保存的配对信息。
     *
     * @param call 调用
     */
    @PluginMethod
    public void load(PluginCall call) {
        JSObject result = new JSObject();
        result.put("url", Pairing.url(getContext()));
        result.put("base", Pairing.base(getContext()));
        result.put("paired", Pairing.isPaired(getContext()));
        call.resolve(result);
    }

    /**
     * 在 WebView 里打开手机控制台页面。
     *
     * @param call 调用
     */
    @PluginMethod
    public void open(PluginCall call) {
        final String url = Pairing.consoleUrlForApp(getContext());
        if (url.isEmpty()) {
            call.reject("还没配对，请先填配对地址");
            return;
        }
        ServiceLog.i("在应用内打开：" + url);
        getActivity().runOnUiThread(() -> {
            try {
                if (getActivity() instanceof MainActivity) {
                    // 标记"现在在控制台"，返回键据此决定是回主页面还是退出应用。
                    ((MainActivity) getActivity()).noteConsoleShown();
                }
                getBridge().getWebView().loadUrl(url);
            } catch (Throwable error) {
                ServiceLog.e("打开控制台失败", error);
            }
        });
        call.resolve();
    }

    /**
     * 从控制台返回应用主页面（配对页）。
     *
     * 控制台是远程网页，它自己没有"回到应用"的办法，Android 返回键也只在页面还能后退时
     * 才有反应。所以必须给页面一个明确的出口：页面上那个「返回应用」按钮会调这里。
     *
     * @param call 调用
     */
    @PluginMethod
    public void home(PluginCall call) {
        ServiceLog.i("控制台请求返回应用主页面");
        getActivity().runOnUiThread(() -> {
            try {
                if (getActivity() instanceof MainActivity) {
                    ((MainActivity) getActivity()).goHomeFromPlugin();
                }
            } catch (Throwable error) {
                ServiceLog.e("返回主页面失败", error);
            }
        });
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * 停止后台服务。
     *
     * @param call 调用
     */
    @PluginMethod
    public void stop(PluginCall call) {
        ConsoleService.stop(getContext());
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * 跳到系统的「实时更新」设置页。
     *
     * 这个开关是应用级的用户设置，清单里没有权限可声明、程序也改不了，
     * 唯一能做的是把用户送过去。
     *
     * @param call 调用
     */
    @PluginMethod
    public void openPromotionSettings(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS);
            intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            intent.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ServiceLog.i("打开系统实时更新设置页");
            getContext().startActivity(intent);
            call.resolve();
        } catch (Throwable error) {
            ServiceLog.e("打开实时更新设置页失败", error);
            // 这条系统页面不是所有 ROM 都实现了，回落打开本应用的通知设置。
            try {
                android.content.Intent fallback = new android.content.Intent(
                        android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                fallback.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                fallback.setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Throwable nested) {
                call.reject("打不开系统设置：" + nested);
            }
        }
    }

    // ---------------------------------------------------------------- 日志

    /**
     * 增量拉日志。
     *
     * @param call 调用，可选 since（上次拿到的最大 seq）
     */
    @PluginMethod
    public void logs(PluginCall call) {
        long since = call.getLong("since", 0L);
        JSObject result = new JSObject();
        result.put("entries", AppLog.toJson(since));
        result.put("lastSeq", AppLog.lastSeq());
        call.resolve(result);
    }

    /**
     * 全部日志拼成一段文本（供复制 / 分享）。
     *
     * @param call 调用
     */
    @PluginMethod
    public void logsText(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", header(getContext().getApplicationContext()) + AppLog.asText());
        call.resolve(result);
    }

    /**
     * 清空日志。
     *
     * @param call 调用
     */
    @PluginMethod
    public void clearLogs(PluginCall call) {
        AppLog.clear();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * 清理过时日志：删掉轮转出来的旧文件，并去掉超过保留天数的行。
     *
     * @param call 调用
     */
    @PluginMethod
    public void purgeLogs(PluginCall call) {
        JSONObject outcome = AppLog.purgeOutdated(getContext(), AppLog.keepDays(getContext()));
        ServiceLog.i("手动清理过时日志：" + outcome.optString("summary", ""));
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removedFiles", outcome.optInt("removedFiles"));
        result.put("removedLines", outcome.optInt("removedLines"));
        result.put("keptLines", outcome.optInt("keptLines"));
        result.put("summary", outcome.optString("summary"));
        call.resolve(result);
    }

    /**
     * 读日志相关的偏好（保留天数、是否启动时自动清理）。
     *
     * @param call 调用
     */
    @PluginMethod
    public void logPrefs(PluginCall call) {
        JSObject result = new JSObject();
        result.put("autoPurge", AppLog.isAutoPurge(getContext()));
        result.put("keepDays", AppLog.keepDays(getContext()));
        call.resolve(result);
    }

    /**
     * 写日志相关的偏好。
     *
     * @param call 调用，可带 autoPurge / keepDays
     */
    @PluginMethod
    public void setLogPrefs(PluginCall call) {
        Boolean autoPurge = call.getBoolean("autoPurge");
        Integer keepDays = call.getInt("keepDays");
        if (autoPurge != null) AppLog.setAutoPurge(getContext(), autoPurge);
        if (keepDays != null) AppLog.setKeepDays(getContext(), keepDays);
        ServiceLog.i("日志偏好已更新：自动清理=" + AppLog.isAutoPurge(getContext())
                + " 保留=" + AppLog.keepDays(getContext()) + " 天");
        JSObject result = new JSObject();
        result.put("autoPurge", AppLog.isAutoPurge(getContext()));
        result.put("keepDays", AppLog.keepDays(getContext()));
        call.resolve(result);
    }

    // ---------------------------------------------------------------- 诊断

    /**
     * 逐条查清"通知为什么会／不会变成灵动岛"，并给一句结论。
     *
     * 网络那一项放后台线程；其余都是本地查询。
     *
     * @param call 调用
     */
    @PluginMethod
    public void diagnose(PluginCall call) {
        final android.content.Context app = getContext().getApplicationContext();
        new Thread(() -> {
            JSObject result = new JSObject();
            JSONArray checks = new JSONArray();
            try {
                result.put("platform", platform());
                add(checks, "pairing", "配对信息", pairingCheck(app));
                add(checks, "permission", "通知权限", permissionCheck(app));
                add(checks, "promotion", "实时更新开关", promotionCheck(app));
                add(checks, "vendor", "厂商通道", vendorCheck(app));
                add(checks, "signature", "签名指纹", signatureCheck(app));
                add(checks, "service", "后台服务", serviceCheck());
                add(checks, "host", "连接电脑", hostCheck(app));
                result.put("checks", checks);
                result.put("verdict", verdict(app));
                ServiceLog.i("诊断结论：" + verdict(app));
            } catch (Throwable error) {
                ServiceLog.e("诊断出错", error);
                result.put("error", String.valueOf(error));
            }
            call.resolve(result);
        }, "dsh-diagnose").start();
    }

    /** 往检查列表里加一项。 */
    private static void add(JSONArray checks, String id, String label, JSONObject value) {
        try {
            value.put("id", id);
            value.put("label", label);
            checks.put(value);
        } catch (Throwable error) {
            // 不会发生，保险。
        }
    }

    /** 机型与系统版本。 */
    private static JSONObject platform() {
        JSONObject value = new JSONObject();
        try {
            value.put("sdk", Build.VERSION.SDK_INT);
            value.put("release", Build.VERSION.RELEASE);
            value.put("manufacturer", Build.MANUFACTURER);
            value.put("model", Build.MODEL);
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /** 配对信息是否可用。 */
    private static JSONObject pairingCheck(android.content.Context context) {
        JSONObject value = new JSONObject();
        try {
            String base = Pairing.base(context);
            String token = Pairing.token(context);
            boolean ok = !base.isEmpty() && !token.isEmpty();
            value.put("ok", ok);
            value.put("detail", ok
                    ? ("已配对：" + base + "（令牌 " + token.length() + " 位）")
                    : "还没有配对，去上面的输入框填配对地址");
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /** 通知权限。 */
    private static JSONObject permissionCheck(android.content.Context context) {
        JSONObject value = new JSONObject();
        try {
            NotificationManager manager = Notifications.manager(context);
            boolean enabled = manager != null && manager.areNotificationsEnabled();
            value.put("ok", enabled);
            value.put("detail", enabled ? "通知已开启" : "通知被关掉了——任何通知都不会出现，更谈不上上岛");
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /**
     * 实时更新（提升）开关。
     *
     * 这是"已经是 Android 16 但通知不是灵动岛"最常见的原因：系统里有一个应用级的
     * 「实时更新」开关，没打开的话通知照发，但不会被提升。
     */
    private static JSONObject promotionCheck(android.content.Context context) {
        JSONObject value = new JSONObject();
        try {
            if (Build.VERSION.SDK_INT < 36) {
                value.put("ok", false);
                value.put("detail", "系统是 Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT
                        + "），低于 Android 16（API 36）：标准实时更新在这个系统上不存在，怎么调都不会有灵动岛。");
                return value;
            }
            boolean allowed = Notifications.promotionAllowed(context);
            int importance = Notifications.liveChannelImportance(context);
            value.put("ok", allowed);
            value.put("detail", (allowed
                    ? "系统已允许本应用发布实时更新"
                    : "系统的「实时更新」开关没开——通知会照常发出，但不会被提升成灵动岛。点下面的按钮去打开。")
                    + "（状态通道重要性=" + importance + "）");
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /** 厂商私有通道（目前只有小米）。 */
    private static JSONObject vendorCheck(android.content.Context context) {
        JSONObject value = new JSONObject();
        try {
            String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
            boolean xiaomiDevice = maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco");
            if (!xiaomiDevice) {
                value.put("ok", true);
                value.put("detail", "非小米设备，不需要厂商私有参数（" + Build.MANUFACTURER + "）");
                return value;
            }
            int protocol = XiaomiIsland.protocol(context);
            boolean usable = XiaomiIsland.canUse(context);
            value.put("ok", usable);
            if (usable) {
                value.put("detail", "小米超级岛可用（焦点通知协议版本 " + protocol + "）");
            } else if (protocol < 2) {
                value.put("detail", "小米设备，但焦点通知协议版本 " + protocol + "（需要 OS2 及以上）");
            } else {
                value.put("detail", "小米设备、协议版本 " + protocol
                        + "，但没有焦点通知权限——普通 APK 拿不到。"
                        + "小米的流程是：注册开发者 → 创建并上架 App → 开发者后台选应用 → 配置指纹证书 → "
                        + "上岛场景预审 → 审核通过后联调联试 → 设备白名单验证 → 提交正式 APK → 灰度放量。");
            }
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /**
     * 签名证书指纹。
     *
     * 小米那套流程里有一步是「配置指纹证书」，所以把指纹直接摆出来；
     * 同时提醒一句：这是**调试签名**，正式上架要换成自己的正式签名包。
     */
    private static JSONObject signatureCheck(android.content.Context context) {
        JSONObject value = new JSONObject();
        try {
            AppSignature.Info info = AppSignature.read(context);
            value.put("ok", info.ok());
            value.put("detail", info.ok()
                    ? (info.summary() + "\nMD5 " + info.md5
                        + "\n（当前是调试签名；要上小米商店需换成你自己的正式签名包，指纹要重新登记）")
                    : "读不到签名指纹");
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /** 前台服务是否在跑。 */
    private static JSONObject serviceCheck() {
        JSONObject value = new JSONObject();
        try {
            boolean running = ConsoleService.isRunning();
            value.put("ok", running);
            value.put("detail", running ? "后台连接服务运行中" : "后台服务没在跑——不会收到任何状态或待办");
        } catch (Throwable error) {
            // 忽略
        }
        return value;
    }

    /** 能不能连上电脑。 */
    private static JSONObject hostCheck(android.content.Context context) {
        JSONObject value = new JSONObject();
        String base = Pairing.base(context);
        String token = Pairing.token(context);
        if (base.isEmpty() || token.isEmpty()) {
            try {
                value.put("ok", false);
                value.put("detail", "还没配对，跳过连接检查");
            } catch (Throwable error) {
                // 忽略
            }
            return value;
        }
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/api/state").openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("X-MC-Token", token);
            int code = connection.getResponseCode();
            StringBuilder builder = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream(),
                    StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) builder.append(line);
            }
            boolean ok = code == 200;
            int sessions = -1;
            if (ok) {
                try {
                    JSONArray array = new JSONObject(builder.toString()).optJSONArray("sessions");
                    sessions = array == null ? 0 : array.length();
                } catch (Throwable error) {
                    sessions = -1;
                }
            }
            value.put("ok", ok);
            value.put("detail", ok
                    ? ("连通正常（HTTP 200，会话 " + sessions + " 个）")
                    : ("电脑回了 HTTP " + code + "：地址或令牌不对，或者插件没在监听"));
        } catch (Throwable error) {
            try {
                value.put("ok", false);
                value.put("detail", "连不上 " + base + "：手机和电脑是不是同一个 Wi-Fi？电脑防火墙放行了吗？（" + error + "）");
            } catch (Throwable nested) {
                // 忽略
            }
        } finally {
            if (connection != null) connection.disconnect();
        }
        return value;
    }

    /**
     * 一句话结论：为什么通知不是灵动岛。
     *
     * @param context 上下文
     * @return 结论
     */
    private static String verdict(android.content.Context context) {
        try {
            if (Build.VERSION.SDK_INT < 36) {
                return "结论：这台手机是 Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT
                        + "），标准实时更新需要 Android 16（API 36）——在这个系统上不可能出现灵动岛。"
                        + vendorHint(context);
            }
            if (!Notifications.promotionAllowed(context)) {
                return "结论：系统支持，但「实时更新」开关没开，所以通知只是普通通知。去系统设置里打开后即可。";
            }
            if (XiaomiIsland.canUse(context)) {
                return "结论：标准通道与小米超级岛都已就绪，通知应该会以灵动岛 / 实时更新的形式出现。";
            }
            return "结论：标准通道已就绪（系统允许实时更新）。如果仍然不是灵动岛，多半是系统还没把这条通知提升——"
                    + "提升与否最终由系统决定（电量策略、通知频率、厂商实现都会影响）。";
        } catch (Throwable error) {
            return "诊断失败：" + error;
        }
    }

    /** 非 Android 16 时补一句这台机器上还有没有别的路子。 */
    private static String vendorHint(android.content.Context context) {
        try {
            if (XiaomiIsland.canUse(context)) return "（小米超级岛参数已启用，那条通道仍有可能生效）";
            String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
            if (maker.contains("xiaomi") || maker.contains("redmi") || maker.contains("poco")) {
                return "（小米设备：焦点通知协议版本 " + XiaomiIsland.protocol(context) + "，且需要小米授予焦点通知权限）";
            }
            return "（荣耀灵动胶囊目前尚未开放原生实时通知 API；华为实况窗、vivo 原子通知需要各自的权益申请）";
        } catch (Throwable error) {
            return "";
        }
    }

    /** 日志开头的环境信息。带上签名指纹——小米那套接入流程要登记它。 */
    private static String header(android.content.Context context) {
        AppSignature.Info signature = AppSignature.read(context);
        return "===== DSH 手机控制台日志 =====\n"
                + "机型：" + Build.MANUFACTURER + " " + Build.MODEL + "\n"
                + "系统：Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT + "）\n"
                + "标准实时更新可用：" + (Build.VERSION.SDK_INT >= 36) + "\n"
                + "实时更新开关：" + Notifications.promotionAllowed(context) + "\n"
                + "状态通道重要性：" + Notifications.liveChannelImportance(context) + "\n"
                + "小米超级岛可用：" + XiaomiIsland.canUse(context)
                + "（协议版本 " + XiaomiIsland.protocol(context) + "）\n"
                + "签名 SHA-256：" + (signature.sha256.isEmpty() ? "读不到" : signature.sha256) + "\n"
                + "=============================\n";
    }
}
