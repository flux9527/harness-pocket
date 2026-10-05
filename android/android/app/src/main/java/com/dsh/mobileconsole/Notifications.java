package com.dsh.mobileconsole;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * 通知构建。
 *
 * 两枚通知：
 * <ul>
 *   <li><b>Live Update</b>（常驻）：智能体状态 + 余额 + 待办数量。会被系统提升成实时更新 / 灵动岛。</li>
 *   <li><b>待审批提醒</b>（高优先级）：带「允许 / 拒绝」按钮，直接回 POST 给插件。</li>
 * </ul>
 *
 * <h3>为什么统一用 androidx 的 NotificationCompat，而不是平台 Notification.Builder</h3>
 *
 * 这里踩过一个很值得记下来的坑。提升为实时更新靠的是 {@code setRequestPromotedOngoing(true)}
 * 和 {@code setShortCriticalText(...)}——我一开始在平台 {@code Notification.Builder} 里
 * 用 javap 逐条查，**确实没有这两个方法**，于是改用平台的
 * {@code ProgressStyle} + {@code setFlag(FLAG_PROMOTED_ONGOING)}。
 *
 * 后来看 rikkahub（一个真机上确实能上岛的 Android 客户端）的实现才发现：它走的是
 * <b>{@code NotificationCompat.Builder}</b>，那上面**两个方法都有**。
 * 也就是说正确做法是把 {@code ProgressStyle} 也换成 androidx 的同名类
 * （{@code NotificationCompat.ProgressStyle}），而不是因为"平台 Style 塞不进 Compat builder"
 * 就把整个 builder 换掉——那样正好把提升能力一起丢掉了。
 *
 * 结论：androidx 一条路走到底，平台类和 Compat 类不要混用。
 */
public final class Notifications {

    public static final String CHANNEL_LIVE = "dsh_live";
    public static final String CHANNEL_ALERT = "dsh_alert";

    /** 常驻通知的固定 id；复用同一个 id 才会"原地更新"而不是堆栈。 */
    public static final int ID_LIVE = 1001;

    /** 待办通知 id 的起点。 */
    private static final int ID_ALERT_BASE = 2000;

    private Notifications() {}

    /** 取通知管理器。 */
    public static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    /** 通知是否被用户允许（API 24+ 一直有这个查询）。 */
    public static boolean allowed(Context context) {
        NotificationManager manager = manager(context);
        return manager != null && manager.areNotificationsEnabled();
    }

    /** 建好两条通道。重复调用是安全的。 */
    public static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = manager(context);
        if (manager == null) return;

        // 常驻状态：低优先级，不出声、不弹横幅，但它会作为 Live Update 显示。
        NotificationChannel live = new NotificationChannel(
                CHANNEL_LIVE, "智能体状态", NotificationManager.IMPORTANCE_LOW);
        live.setDescription("常驻显示 DSH 智能体运行状态、余额与待办数量");
        live.setShowBadge(false);
        manager.createNotificationChannel(live);

        // 审批提醒：高优先级，要能弹出来让人看到。
        NotificationChannel alert = new NotificationChannel(
                CHANNEL_ALERT, "审批与提问", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("有审批或提问需要你处理时提醒");
        manager.createNotificationChannel(alert);
    }

    /**
     * 建一个绑好通道的通知构造器。
     *
     * @param context 上下文
     * @param channelId 通道 id
     * @return 构造器
     */
    private static NotificationCompat.Builder builder(Context context, String channelId) {
        return new NotificationCompat.Builder(context, channelId);
    }

    /**
     * 打开应用的 PendingIntent。
     *
     * @param context 上下文
     * @return PendingIntent
     */
    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 打开手机控制台的 PendingIntent。
     *
     * 带上一个"提示"，让应用知道用户是点了哪个按钮进来的：
     * 控制台页面读地址栏的 `#stop` / `#compose` 就能把界面滚到对应位置。
     *
     * @param context 上下文
     * @param hint 提示：{@code stop} / {@code compose} / null
     * @return PendingIntent
     */
    private static PendingIntent openConsole(Context context, String hint) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(MainActivity.EXTRA_OPEN_CONSOLE, true);
        if (hint != null) intent.putExtra(MainActivity.EXTRA_HINT, hint);
        // 请求码要区分开，否则几个动作会互相覆盖。
        int requestCode = hint == null ? 0x51 : hint.hashCode();
        return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 常驻的 Live Update 通知。
     *
     * @param context 上下文
     * @param state 当前状态
     * @param connected 是否已连上插件
     * @return 通知
     */
    public static Notification liveUpdate(Context context, ConsoleState state, boolean connected) {
        // 岛上左边那张图 = 通知的小图标，按状态换；右边那行 = 大标题。
        int icon = stateIcon(state.kind(connected));
        String title = state.stateTitle(connected);
        String summary = state.summaryLine();

        NotificationCompat.Builder builder = builder(context, CHANNEL_LIVE)
                .setSmallIcon(icon)
                .setContentTitle(title)
                .setContentText(summary.isEmpty() ? state.statusSummary() : summary)
                .setOngoing(true)
                .setSilent(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(openConsole(context, null))
                .setPriority(NotificationCompat.PRIORITY_LOW)
                // 类别用 PROGRESS：官方文档与实测能上岛的实现共用的取值。
                .setCategory(NotificationCompat.CATEGORY_PROGRESS);

        if (!connected) {
            builder.setSubText("等待重连");
        } else {
            // 副标题放"运行中 / 空闲"这类计数，正文留给余额与待办（展开就能看到）。
            String counts = state.statusSummary();
            if (!counts.isEmpty()) builder.setSubText(counts);
        }

        // 注意：下面 attachLiveUpdate 里会用 ProgressStyle 调 setStyle，而 setStyle 是**覆盖式**的，
        // 所以这里不能再用 BigTextStyle——两者只能留一个。展开态的样子由 ProgressStyle 决定：
        // 进度条 + 正文 + 副标题 + 操作按钮。文字信息因此全部走 title / contentText / subText。
        addLiveActions(context, builder, state);
        attachLiveUpdate(context, builder, state, connected);
        Notification notification = builder.build();
        // 厂商私有通道：小米超级岛。探测不通过时这个调用立刻返回，普通通知完全不受影响。
        XiaomiIsland.decorateStatus(context, notification, state);
        return notification;
    }

    /**
     * 状态 → 岛上左边那张图。
     *
     * @param kind 状态
     * @return drawable 资源
     */
    private static int stateIcon(ConsoleState.Kind kind) {
        switch (kind) {
            case DISCONNECTED:
                return R.drawable.ic_state_disconnected;
            case APPROVAL:
                return R.drawable.ic_state_approval;
            case RUNNING:
                return R.drawable.ic_state_running;
            default:
                return R.drawable.ic_state_idle;
        }
    }

    /**
     * 常驻通知上的操作按钮。
     *
     * 待审批时把「允许 / 拒绝」直接放到常驻通知上——**岛上展示的就是这条通知**，
     * 所以按钮也就跟着上岛了，不用等另一条待办通知。
     * 「停止」「发消息」按需求都是"跳到手机控制台去操作"，不在这里直接执行——
     * 停止一个正在跑的回合是不可逆的，值得让人在那个界面里看清楚再点。
     *
     * @param context 上下文
     * @param builder 构造器
     * @param state 当前状态
     */
    private static void addLiveActions(Context context, NotificationCompat.Builder builder, ConsoleState state) {
        ConsoleState.Pending approval = state.firstApproval();
        if (approval != null) {
            builder.addAction(R.drawable.ic_state_approval, "允许",
                    answerIntent(context, approval.requestId, "allow"));
            builder.addAction(R.drawable.ic_state_approval, "拒绝",
                    answerIntent(context, approval.requestId, "deny"));
        }
        builder.addAction(R.drawable.ic_state_idle, "停止", openConsole(context, "stop"));
        builder.addAction(R.drawable.ic_state_idle, "发消息", openConsole(context, "compose"));
    }

    /**
     * 把常驻通知升级成 Live Update。
     *
     * 写法照着两个真机上确实能上岛的开源实现来（rikkahub、InstallerX-Revived），
     * 它们在这件事上高度一致：
     * <ol>
     *   <li>{@code setRequestPromotedOngoing(true)} —— **关键那一步**。两边都直接调用、
     *       都不做版本判断（androidx 内部按版本处理），我一开始在平台 Builder 里找这个方法
     *       找不到就放弃了，是找错了族。</li>
     *   <li>{@code setShortCriticalText(chip)} —— 状态栏 chip 上那行极短文字。</li>
     *   <li>{@code ProgressStyle} + {@code setStyledByProgress(true)} + {@code setProgress(n)}
     *       —— 岛上的进度条就是这么来的。</li>
     *   <li>{@code addAction(0, 标题, PendingIntent)} —— 岛上的操作按钮。</li>
     * </ol>
     *
     * 三步各自独立 try：任何一步出问题都不能连累"请求提升"这一步，否则就本末倒置了。
     *
     * @param context 上下文
     * @param builder 构造器
     * @param state 当前状态
     * @param connected 是否已连上电脑（决定 chip 上写什么）
     */
    private static void attachLiveUpdate(Context context, NotificationCompat.Builder builder, ConsoleState state, boolean connected) {
        // 1) 请求提升。这是能不能上岛的决定性一步，放在最前面、单独兜异常。
        try {
            builder.setRequestPromotedOngoing(true);
        } catch (Throwable error) {
            ServiceLog.w("请求提升（setRequestPromotedOngoing）失败：" + error);
        }

        // 没被允许提升时，给一个一键跳到系统开关的入口。
        if (Build.VERSION.SDK_INT >= 36 && !promotionAllowed(context)) {
            // 注意：NotificationCompat 的 addAction 收的是 IconCompat 或资源 id（0 = 不要图标），
            // **不是**平台的 android.graphics.drawable.Icon。
            builder.addAction(0, "开启实时更新", promotionSettingsIntent(context));
        }

        // 2) 状态栏 chip 的短文字：写当前状态（"运行 2" / "审批 1" / "空闲" / "断联"）。
        // 余额改放展开态的正文里——chip 位置太窄，状态比金额更值得一眼看到。
        String chip = state.stateShort(connected);
        if (!chip.isEmpty()) {
            try {
                builder.setShortCriticalText(chip);
            } catch (Throwable error) {
                ServiceLog.w("设置 chip 文字失败：" + error);
            }
        }

        // 3) 进度条 + 分段。纯视觉，失败不影响提升。
        try {
            NotificationCompat.ProgressStyle style = new NotificationCompat.ProgressStyle();

            int sessions = Math.max(1, state.running + state.idle + state.offline);
            List<NotificationCompat.ProgressStyle.Segment> segments = new ArrayList<>();
            for (int index = 0; index < sessions; index++) {
                segments.add(new NotificationCompat.ProgressStyle.Segment(1));
            }
            style.setProgressSegments(segments);
            // 让进度条的样式跟着进度走（InstallerX 就是这么写的）。
            style.setStyledByProgress(true);
            // 进度取"运行中会话占比"：0=全空闲，100=全在跑。
            // 这是本应用里唯一一个有意义的连续量——待办是离散的，用它当进度会误导。
            int active = state.running + state.idle;
            style.setProgress(active <= 0 ? 0 : Math.round(100f * state.running / active));

            builder.setStyle(style);
        } catch (Throwable error) {
            ServiceLog.w("ProgressStyle 附加失败（不影响提升）：" + error);
        }
    }

    /**
     * 系统是否允许本应用发布"被提升"的通知。
     *
     * Android 16 的实时更新不是调了 API 就一定有：它另有一个**用户侧的开关**，
     * 由 {@link NotificationManager#canPostPromotedNotifications()} 报告。
     * 清单里没有对应权限可声明（我在这份 API 36 的 android.jar 里逐条目扫过），
     * 程序改不了，只能引导用户去点。
     *
     * @param context 上下文
     * @return 是否允许提升
     */
    public static boolean promotionAllowed(Context context) {
        if (Build.VERSION.SDK_INT < 36) return false;
        try {
            NotificationManager manager = manager(context);
            return manager != null && manager.canPostPromotedNotifications();
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 常驻状态通知所在通道的重要性。
     *
     * 诊断页会把它显示出来。网上有说法称"提升要求通道必须是 IMPORTANCE_HIGH"，
     * 但我没能在官方文档正文里核实，而把常驻状态通知调成 HIGH 意味着每次状态刷新都弹横幅，
     * 与"安静地待在岛上"相悖，所以没有采纳。把实际值露出来，为的是万一真要调整时有依据。
     *
     * @param context 上下文
     * @return 重要性；查不到时 -1
     */
    public static int liveChannelImportance(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return -1;
        try {
            NotificationManager manager = manager(context);
            if (manager == null) return -1;
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL_LIVE);
            return channel == null ? -1 : channel.getImportance();
        } catch (Throwable error) {
            return -1;
        }
    }

    /**
     * 跳到本应用的「实时更新」设置页（API 36 的
     * {@code android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS}）。
     *
     * @param context 上下文
     * @return PendingIntent
     */
    private static PendingIntent promotionSettingsIntent(Context context) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 待办通知的 id。
     *
     * @param requestId 请求 id
     * @return 通知 id
     */
    public static int alertId(String requestId) {
        return ID_ALERT_BASE + Math.abs(requestId.hashCode() % 700);
    }

    /**
     * 一条待办的通知，审批类带「允许 / 拒绝」按钮。
     *
     * @param context 上下文
     * @param pending 待办
     * @param state 当前状态
     * @return 通知
     */
    public static Notification pending(Context context, ConsoleState.Pending pending, ConsoleState state) {
        boolean approval = pending.isApproval();
        String tool = pending.toolName == null || pending.toolName.isEmpty() ? "某个工具" : pending.toolName;

        String title = approval ? "需要审批：" + tool : "有提问需要回答";
        String detail;
        if (approval) {
            detail = "点「允许」直接放行，点「拒绝」直接拦下——不用打开电脑。";
        } else {
            detail = pending.questionTitle.isEmpty() ? "点开在手机上作答。" : pending.questionTitle;
        }

        NotificationCompat.Builder builder = builder(context, CHANNEL_ALERT)
                .setSmallIcon(R.drawable.ic_stat_console)
                .setContentTitle(title)
                .setContentText(detail)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(detail))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setAutoCancel(!approval)
                .setContentIntent(openApp(context));

        String summary = state.summaryLine();
        if (!summary.isEmpty()) builder.setSubText(summary);

        if (approval) {
            PendingIntent allow = answerIntent(context, pending.requestId, "allow");
            PendingIntent deny = answerIntent(context, pending.requestId, "deny");
            builder.addAction(R.drawable.ic_stat_console, "允许", allow);
            builder.addAction(R.drawable.ic_stat_console, "拒绝", deny);
            Notification notification = builder.build();
            // 小米超级岛上也能直接点「允许 / 拒绝」——同一对 PendingIntent，行为完全一致。
            XiaomiIsland.decorateApproval(context, notification, title, detail, allow, deny);
            return notification;
        }
        return builder.build();
    }

    /**
     * 「允许 / 拒绝」按钮的 PendingIntent。
     *
     * 用广播而不是 Activity：Android 12+ 禁止通知动作借 Activity 当跳板，而且这里
     * 也不需要界面——后台服务直接回一个 POST 就行。
     *
     * @param context 上下文
     * @param requestId 请求 id
     * @param decision allow / deny
     * @return PendingIntent
     */
    private static PendingIntent answerIntent(Context context, String requestId, String decision) {
        Intent intent = new Intent(context, ApprovalReceiver.class);
        intent.setAction(ApprovalReceiver.ACTION_ANSWER);
        // 厂商文档（小米超级岛）明确要求：通知动作里的广播 PendingIntent 要带这个标志，
        // 否则从岛上点下来的广播可能被后台限制压住。
        intent.addFlags(Intent.FLAG_RECEIVER_FOREGROUND);
        intent.putExtra(ApprovalReceiver.EXTRA_REQUEST_ID, requestId);
        intent.putExtra(ApprovalReceiver.EXTRA_DECISION, decision);
        // 请求码必须区分开，否则两个按钮会互相覆盖。
        int requestCode = (requestId + decision).hashCode();
        return PendingIntent.getBroadcast(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 取消某条待办的通知。
     *
     * @param context 上下文
     * @param requestId 请求 id
     */
    public static void cancelPending(Context context, String requestId) {
        NotificationManager manager = manager(context);
        if (manager != null) manager.cancel(alertId(requestId));
    }
}
