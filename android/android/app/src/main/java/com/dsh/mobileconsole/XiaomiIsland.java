package com.dsh.mobileconsole;

import android.app.Notification;
import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/**
 * 小米 HyperOS「超级岛 / 焦点通知」适配层。
 *
 * <h3>为什么只做小米一家</h3>
 * 各家"灵动岛"其实分两类：
 * <ul>
 *   <li><b>跟随 Android 16 官方规范的</b>——荣耀灵动胶囊、OPPO ColorOS 16 流体云等明确按
 *       Google 的 Live Activities 规范适配。这部分由 {@link Notifications} 里的
 *       {@code ProgressStyle} + {@code FLAG_PROMOTED_ONGOING} 覆盖，不需要厂商私有代码。</li>
 *   <li><b>厂商私有通道的</b>——小米（本类）、华为实况窗、vivo 原子通知。其中只有小米提供了
 *       **公开的客户端实现方式**；华为和 vivo 要走各自的"服务权益申请"，不是普通 APK 能自办的。</li>
 * </ul>
 *
 * <h3>安全前提</h3>
 * 岛参数是一串 JSON 塞进 {@code Notification.extras} 的 {@code miui.focus.param}。字段名与模板
 * 结构随 ROM 版本变化，而**模板库细节不在公开文档正文里**（单独的 PDF）。所以这里的策略是：
 * 能力探测通过才附加、只用文档正文里明确写出的字段、整体 try/catch 兜住。
 * 最坏情况是"岛没显示"或"岛显示得不好看"——**普通通知本身不受影响**，因为改的是同一个
 * Notification 对象上的 extras，别的字段照旧。
 *
 * 文档依据：小米澎湃OS 开发者平台《小米超级岛 - 开发指南》。
 */
public final class XiaomiIsland {

    /** 焦点通知权限查询用的 SystemUI 提供方。 */
    private static final Uri FOCUS_PERMISSION_URI = Uri.parse("content://miui.statusbar.notification.public");

    /** 图片与 Action 在 extras 里的容器 key（文档附录）。 */
    private static final String KEY_PICS = "miui.focus.pics";
    private static final String KEY_ACTIONS = "miui.focus.actions";
    private static final String KEY_PARAM = "miui.focus.param";

    /**
     * {@code miui.focus.param} 的字节上限。
     *
     * 官方 FAQ 明确写了 3072 字节。超了会怎样没有说明，但既然是个明文限制，
     * 就不能赌它会被截断——宁可自己先把长文本砍掉。
     */
    private static final int PARAM_MAX_BYTES = 3072;

    /** 图片 / Action 在容器里的条目 key，JSON 里按这些名字引用。 */
    private static final String PIC_ISLAND = "miui.focus.pic_island";
    private static final String PIC_TICKER = "miui.focus.pic_ticker";
    private static final String ACTION_ALLOW = "miui.focus.action_allow";
    private static final String ACTION_DENY = "miui.focus.action_deny";

    /** 探测结果缓存：SystemProperties 反射和跨进程查询都不便宜，每次发通知都做没必要。 */
    private static volatile Boolean islandSupported = null;
    private static volatile int protocolVersion = -1;
    private static volatile long probedAt = 0L;
    private static final long PROBE_TTL_MS = 60_000L;

    private XiaomiIsland() {}

    /**
     * 这台设备能不能用岛通知。
     *
     * 三重条件缺一不可：系统开启了岛特性、协议版本 >= 2（OS2 起有焦点通知）、
     * 且用户没有关掉本应用的焦点通知权限。
     *
     * @param context 上下文
     * @return 是否可用
     */
    public static boolean canUse(Context context) {
        try {
            if (!isIslandFeatureOn()) return false;
            if (protocol(context) < 2) return false;
            return hasFocusPermission(context);
        } catch (Throwable error) {
            // 探测本身出任何问题都当作"不支持"，绝不让适配层影响主流程。
            return false;
        }
    }

    /** 系统属性 {@code persist.sys.feature.island}（文档给的反射写法）。 */
    private static boolean isIslandFeatureOn() {
        try {
            Class<?> properties = Class.forName("android.os.SystemProperties");
            Method getBoolean = properties.getDeclaredMethod("getBoolean", String.class, boolean.class);
            Object value = getBoolean.invoke(null, "persist.sys.feature.island", false);
            return value instanceof Boolean && (Boolean) value;
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 焦点通知协议版本：1=OS1，2=OS2，3=OS3（OS3 才有超级岛）。
     *
     * @param context 上下文
     * @return 版本号；查不到时 0
     */
    public static int protocol(Context context) {
        long now = SystemClock.elapsedRealtime();
        if (protocolVersion >= 0 && now - probedAt < PROBE_TTL_MS) return protocolVersion;
        int value = 0;
        try {
            value = Settings.System.getInt(
                    context.getContentResolver(), "notification_focus_protocol", 0);
        } catch (Throwable error) {
            value = 0;
        }
        protocolVersion = value;
        probedAt = now;
        return value;
    }

    /**
     * 用户是否给本应用开了焦点通知权限。
     *
     * @param context 上下文
     * @return 是否开启
     */
    public static boolean hasFocusPermission(Context context) {
        try {
            ContentResolver resolver = context.getContentResolver();
            Bundle extras = new Bundle();
            extras.putString("package", context.getPackageName());
            Bundle result = resolver.call(FOCUS_PERMISSION_URI, "canShowFocus", null, extras);
            return result != null && result.getBoolean("canShowFocus", false);
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 给常驻状态通知附加岛参数。
     *
     * 常驻通知的策略是**不抢焦点**：{@code islandFirstFloat=false} + {@code enableFloat=false}，
     * 更新时不自动展开，只在岛上安静地待着；{@code updatable=true} 让后续更新能刷新岛内容。
     *
     * @param context 上下文
     * @param notification 已经 build 好的通知
     * @param state 当前状态
     */
    public static void decorateStatus(Context context, Notification notification, ConsoleState state) {
        if (!canUse(context)) return;
        try {
            JSONObject param = new JSONObject();
            JSONObject v2 = new JSONObject();
            v2.put("protocol", 1);
            v2.put("business", "dsh_agent");
            v2.put("islandFirstFloat", false);
            v2.put("enableFloat", false);
            v2.put("updatable", true);
            v2.put("ticker", trim(state.statusSummary(), 32));
            v2.put("aodTitle", trim(state.statusSummary(), 24));

            JSONObject base = new JSONObject();
            base.put("title", "DSH 智能体");
            base.put("content", trim(state.summaryLine().isEmpty() ? state.statusSummary() : state.summaryLine(), 60));
            v2.put("baseInfo", base);

            v2.put("param_island", islandAreas(
                    "DSH", state.running > 0 ? "运行中 " + state.running : "空闲",
                    state.summaryLine()));

            param.put("param_v2", v2);
            putParam(notification, param);

            Bundle pics = new Bundle();
            pics.putParcelable(PIC_ISLAND, android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_stat_console));
            pics.putParcelable(PIC_TICKER, android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_stat_console));
            Bundle extras = new Bundle();
            extras.putBundle(KEY_PICS, pics);
            notification.extras.putAll(extras);
        } catch (Throwable error) {
            ServiceLog.w("小米岛参数附加失败（已忽略，普通通知不受影响）：" + error);
        }
    }

    /**
     * 给待审批通知附加岛参数，把「允许 / 拒绝」一起放到岛上。
     *
     * 这条要**抢一次焦点**（{@code islandFirstFloat=true}）：审批是等人操作的事，
     * 一闪而过的摘要态没用。两个动作直接引用下面注册的 Notification.Action。
     *
     * @param context 上下文
     * @param notification 已经 build 好的通知
     * @param title 标题
     * @param content 正文
     * @param allow 允许的 PendingIntent
     * @param deny 拒绝的 PendingIntent
     */
    public static void decorateApproval(
            Context context,
            Notification notification,
            String title,
            String content,
            android.app.PendingIntent allow,
            android.app.PendingIntent deny) {
        if (!canUse(context)) return;
        try {
            JSONObject param = new JSONObject();
            JSONObject v2 = new JSONObject();
            v2.put("protocol", 1);
            v2.put("business", "dsh_approval");
            v2.put("islandFirstFloat", true);
            v2.put("enableFloat", true);
            v2.put("updatable", false);
            v2.put("ticker", trim(title, 32));
            v2.put("aodTitle", trim(title, 24));

            JSONObject base = new JSONObject();
            base.put("title", trim(title, 40));
            base.put("content", trim(content, 60));
            base.put("type", 2);
            v2.put("baseInfo", base);

            JSONArray actions = new JSONArray();
            actions.put(new JSONObject().put("action", ACTION_ALLOW));
            actions.put(new JSONObject().put("action", ACTION_DENY));
            v2.put("actions", actions);

            v2.put("param_island", islandAreas("DSH", trim(title, 20), content));

            param.put("param_v2", v2);
            putParam(notification, param);

            Bundle pics = new Bundle();
            pics.putParcelable(PIC_ISLAND, android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_stat_console));
            pics.putParcelable(PIC_TICKER, android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_stat_console));

            Bundle actionBundle = new Bundle();
            actionBundle.putParcelable(ACTION_ALLOW, new Notification.Action.Builder(
                    android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_stat_console), "允许", allow).build());
            actionBundle.putParcelable(ACTION_DENY, new Notification.Action.Builder(
                    android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_stat_console), "拒绝", deny).build());

            Bundle extras = new Bundle();
            extras.putBundle(KEY_PICS, pics);
            extras.putBundle(KEY_ACTIONS, actionBundle);
            notification.extras.putAll(extras);
        } catch (Throwable error) {
            ServiceLog.w("小米岛审批参数附加失败（已忽略，通知按钮照常可用）：" + error);
        }
    }

    /**
     * 拼大岛 / 小岛的内容区。
     *
     * 模板字段随 ROM 版本变，这里只用文档正文示例里出现过的最小结构：小岛一张图，
     * 大岛「文本 + 图」。字段多了反而更容易在别的版本上渲染错。
     *
     * @param front 前缀（小字）
     * @param title 主标题
     * @param content 正文
     * @return 岛内容对象
     */
    private static JSONObject islandAreas(String front, String title, String content) throws Exception {
        JSONObject picInfo = new JSONObject();
        picInfo.put("type", 1);
        picInfo.put("pic", PIC_ISLAND);

        JSONObject textInfo = new JSONObject();
        textInfo.put("frontTitle", trim(front, 8));
        textInfo.put("title", trim(title, 16));
        textInfo.put("content", trim(content, 24));
        textInfo.put("useHighLight", false);

        JSONObject left = new JSONObject();
        left.put("type", 1);
        left.put("picInfo", picInfo);
        left.put("textInfo", textInfo);

        JSONObject big = new JSONObject();
        big.put("islandProperty", 1);
        big.put("imageTextInfoLeft", left);
        big.put("picInfo", picInfo);

        JSONObject small = new JSONObject();
        small.put("picInfo", picInfo);

        JSONObject island = new JSONObject();
        island.put("islandProperty", 1);
        island.put("bigIslandArea", big);
        island.put("smallIslandArea", small);
        return island;
    }

    /**
     * 把岛参数写进通知 extras，顺便守住 3072 字节上限。
     *
     * 超了就**整条不附加**而不是截断字符串：截断 JSON 可能得到不合法的结构，
     * 那时候 ROM 那边的表现更不可控。宁可岛不显示，也不能塞一段坏数据。
     *
     * @param notification 通知
     * @param param 岛参数
     */
    private static void putParam(Notification notification, JSONObject param) {
        String json = param.toString();
        int size = json.getBytes(StandardCharsets.UTF_8).length;
        if (size > PARAM_MAX_BYTES) {
            ServiceLog.w("小米岛参数 " + size + " 字节，超过官方上限 " + PARAM_MAX_BYTES + "，本次不附加（普通通知不受影响）");
            return;
        }
        notification.extras.putString(KEY_PARAM, json);
    }

    /**
     * 截断到指定长度，避免超长文本把岛撑坏。
     *
     * @param value 原文本
     * @param max 最大长度
     * @return 截断后的文本
     */
    private static String trim(String value, int max) {
        String text = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        return text.length() <= max ? text : text.substring(0, max) + "…";
    }
}
