package com.dsh.mobileconsole;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/**
 * 常驻前台服务：抱着一条到电脑的 SSE 长连接，随时把智能体状态变成通知。
 *
 * 为什么要前台服务：Android 不允许普通后台进程长期持有网络连接，息屏几分钟就会被掐断；
 * 而"审批随时可能来"要求连接必须活着。前台服务的代价是一条不可消除的常驻通知——正好
 * 也是我们要的 Live Update 载体。
 *
 * 前台服务类型用 {@code specialUse} 而不是 {@code dataSync}：Android 15 起 dataSync 有
 * 每 24 小时 6 小时的累计上限，而这是个需要长期挂着连接的工具。
 */
public class ConsoleService extends Service {

    public static final String ACTION_START = "com.dsh.mobileconsole.START";
    public static final String ACTION_STOP = "com.dsh.mobileconsole.STOP";

    /** 重连退避的起点与上限。 */
    private static final long BACKOFF_MIN_MS = 1_000;
    private static final long BACKOFF_MAX_MS = 30_000;

    private volatile boolean running = false;

    /** 服务是否在跑。诊断页要用它回答"后台连接到底起没起来"。 */
    private static volatile boolean alive = false;

    /**
     * @return 前台服务当前是否在运行
     */
    public static boolean isRunning() {
        return alive;
    }
    private Thread worker;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 当前快照；主线程读写。 */
    private volatile ConsoleState latest = new ConsoleState();
    private volatile boolean connected = false;

    /** 已经发过通知的待办 id，避免同一件事反复打扰。 */
    private final Set<String> notified = new HashSet<>();

    private final Set<Integer> shownAlerts = new HashSet<>();

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 服务有可能被广播先拉起来（那时 Activity 还没跑过），日志在这里兜一次底。
        AppLog.init(this);
        String action = intent == null ? ACTION_START : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            ServiceLog.i("收到停止指令");
            stopSelf();
            return START_NOT_STICKY;
        }

        // 必须尽快进入前台：startForegroundService 之后系统只给几秒钟。
        goForeground();

        if (!running) {
            running = true;
            alive = true;
            worker = new Thread(this::workerLoop, "dsh-sse");
            worker.setDaemon(true);
            worker.start();
            // 把厂商通道的能力一次性写进日志：出问题时能立刻分清"这台机器不支持"
            // 和"支持但参数没生效"，省得靠猜。
            ServiceLog.i("通知通道：Android " + Build.VERSION.RELEASE
                    + "（API " + Build.VERSION.SDK_INT + "）"
                    + "；标准 Live Updates=" + (Build.VERSION.SDK_INT >= 36)
                    + "；实时更新开关（提升权限）=" + Notifications.promotionAllowed(this)
                    + "；小米超级岛可用=" + XiaomiIsland.canUse(this)
                    + "（协议版本 " + XiaomiIsland.protocol(this) + "）");
            ServiceLog.i("后台连接已启动");
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        ServiceLog.i("后台连接已停止");
        running = false;
        alive = false;
        if (worker != null) worker.interrupt();
        worker = null;
        super.onDestroy();
    }

    /** 进入前台并显示常驻的 Live Update 通知。 */
    private void goForeground() {
        Notifications.ensureChannels(this);
        Notification notification = Notifications.liveUpdate(this, latest, connected);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(Notifications.ID_LIVE, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(Notifications.ID_LIVE, notification);
            }
        } catch (Exception error) {
            ServiceLog.e("进入前台失败：" + error);
        }
    }

    // ------------------------------------------------------------ SSE

    /** 断线就退避重连，直到服务被停止。 */
    private void workerLoop() {
        long backoff = BACKOFF_MIN_MS;
        while (running) {
            try {
                streamOnce();
                backoff = BACKOFF_MIN_MS;
            } catch (Exception error) {
                if (running) ServiceLog.w("SSE 中断：" + error);
            }
            main.post(() -> setConnected(false));
            if (!running) break;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
    }

    /**
     * 建立一次 SSE 连接并读到断开。
     *
     * 帧格式是标准的 {@code event:} / {@code data:}，空行结束一帧。这里只认 state 帧，
     * 其它事件一律忽略——插件将来加新事件时不会把它当成快照。
     */
    private void streamOnce() throws Exception {
        if (!Pairing.isPaired(this)) {
            ServiceLog.w("还没配对，等待配对后再连");
            Thread.sleep(BACKOFF_MIN_MS);
            return;
        }
        String url = Pairing.base(this) + "/api/events";
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestProperty("X-MC-Token", Pairing.token(this));
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setConnectTimeout(15_000);
        // SSE 是长连接，读超时必须关掉，否则空闲一会儿就会被误判成断开。
        connection.setReadTimeout(0);

        try {
            int code = connection.getResponseCode();
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            main.post(() -> setConnected(true));
            ServiceLog.i("已连上 " + url);

            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
            String event = null;
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if ("state".equals(event) && data.length() > 0) handleSnapshot(data.toString());
                    event = null;
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) continue; // 心跳注释
                if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 收到一帧快照。
     *
     * @param json 快照 JSON
     */
    private void handleSnapshot(String json) {
        ConsoleState state;
        try {
            state = ConsoleState.fromJson(new JSONObject(json));
        } catch (Exception error) {
            ServiceLog.w("快照解析失败：" + error);
            return;
        }
        main.post(() -> applyState(state));
    }

    /**
     * 应用新状态：更新常驻 Live Update，并同步待办通知。
     *
     * 待办通知的生命周期**只由这里管**：新出现的发一条，从快照里消失的撤掉。
     * 这样即使某次「允许」的网络请求失败，待办还在快照里，通知也就还在，可以再点一次。
     *
     * @param state 新状态
     */
    private void applyState(ConsoleState state) {
        latest = state;
        NotificationManager manager = Notifications.manager(this);
        if (manager == null || !manager.areNotificationsEnabled()) return;

        manager.notify(Notifications.ID_LIVE, Notifications.liveUpdate(this, state, connected));

        Set<String> current = new HashSet<>();
        for (ConsoleState.Pending pending : state.pendings) {
            current.add(pending.requestId);
            int id = Notifications.alertId(pending.requestId);
            if (shownAlerts.add(id)) {
                ServiceLog.i("发出待办通知 kind=" + pending.kind
                        + " tool=" + (pending.toolName == null || pending.toolName.isEmpty() ? "-" : pending.toolName)
                        + " id=" + pending.requestId);
                manager.notify(id, Notifications.pending(this, pending, state));
            }
        }
        for (Iterator<Integer> iterator = shownAlerts.iterator(); iterator.hasNext(); ) {
            int id = iterator.next();
            boolean stillThere = false;
            for (String requestId : current) {
                if (Notifications.alertId(requestId) == id) {
                    stillThere = true;
                    break;
                }
            }
            if (!stillThere) {
                manager.cancel(id);
                iterator.remove();
            }
        }
        // notified 只用于日志/诊断，跟着一起清。
        notified.retainAll(current);
        notified.addAll(current);
    }

    /**
     * 更新连接状态并刷新常驻通知。
     *
     * @param value 是否已连上
     */
    private void setConnected(boolean value) {
        if (connected == value) return;
        connected = value;
        ServiceLog.i(value ? "已连上电脑，开始接收状态" : "与电脑断开，进入重连退避");
        NotificationManager manager = Notifications.manager(this);
        if (manager != null && manager.areNotificationsEnabled()) {
            manager.notify(Notifications.ID_LIVE, Notifications.liveUpdate(this, latest, connected));
        }
    }

    /**
     * 启动服务。
     *
     * @param context 上下文
     */
    public static void start(Context context) {
        Intent intent = new Intent(context, ConsoleService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /**
     * 停止服务。
     *
     * @param context 上下文
     */
    public static void stop(Context context) {
        Intent intent = new Intent(context, ConsoleService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }
}
