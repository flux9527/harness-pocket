package com.dsh.mobileconsole;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 唯一的活动：Capacitor 的 WebView 外壳。
 *
 * 未配对时展示打包进来的配对页；配对后由 {@link PairingPlugin#open} 把 WebView 导航到
 * 电脑上的手机界面。
 *
 * 通知上的动作（停止 / 发消息，以及点通知本体）也走这里：带上
 * {@link #EXTRA_OPEN_CONSOLE} 与 {@link #EXTRA_HINT} 直接进控制台，并把提示写进地址栏
 * 的 fragment（{@code #stop} / {@code #compose}），页面据此把界面滚到对应位置。
 *
 * <h3>返回键为什么要用 OnBackPressedDispatcher</h3>
 *
 * 一开始我只覆盖了 {@code onBackPressed()}，结果在真机上**完全没生效**——按返回直接回桌面。
 * 原因是 Android 13+ 的预测性返回：系统走 {@code OnBackPressedDispatcher}，
 * 直接调用注册进去的回调，**不会**再经过 Activity 的 {@code onBackPressed()} 覆盖方法。
 * Capacitor 自己注册过一个（WebView 退不动就 finish），于是它先拿到返回键，把应用退到后台。
 *
 * 正确做法是往 dispatcher 里**再注册一个回调**。dispatcher 按"后注册先调用"的顺序派发，
 * 而 Capacitor 是在 {@code super.onCreate()} 里注册的，所以只要在它之后再注册，
 * 就能先拿到返回键。{@code onBackPressed()} 的覆盖保留着，照顾老系统。
 */
public class MainActivity extends BridgeActivity {

    /** 通知动作要求"打开控制台"。没有这个 extra 时按原来的行为（展示配对页）。 */
    public static final String EXTRA_OPEN_CONSOLE = "mc_open_console";

    /** 打开控制台后要提示的位置：{@code stop} / {@code compose}。 */
    public static final String EXTRA_HINT = "mc_hint";

    private static final int REQUEST_NOTIFICATIONS = 41;

    /**
     * 当前是不是停在控制台页面上。
     *
     * 用一个显式标志，而不是每次都去比 URL 字符串——URL 里可能少一个斜杠、
     * 多一个默认端口，比对上就会静默失败，表现就是"返回键没反应、⌂ 按钮也没反应"。
     * URL 比对只作为兜底（Activity 被重建后标志会丢）。
     */
    private volatile boolean showingConsole = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册，Capacitor 在启动时会读插件表。
        registerPlugin(PairingPlugin.class);
        super.onCreate(savedInstanceState);
        // 日志尽早初始化：它会把上次运行留下的尾部读回内存，
        // 所以"启动就失败"这种情况也能在应用里看到上一次的记录。
        AppLog.init(this);
        ServiceLog.i("应用启动：Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT + "）"
                + " / " + Build.MANUFACTURER + " " + Build.MODEL);
        ServiceLog.i("通知通道探测：通知=" + Notifications.allowed(this)
                + "；实时更新=" + Notifications.promotionAllowed(this)
                + "；小米超级岛=" + XiaomiIsland.canUse(this));
        requestNotificationPermission();
        applySystemBarInsets();
        registerBackHandling();
        if (Pairing.isPaired(this)) {
            // 应用被重新打开时顺手把后台连接拉起来（重启手机后用户可能只打开了应用）。
            ConsoleService.start(this);
            openConsoleIfRequested(getIntent());
        }
    }

    /**
     * 注册返回键处理：在控制台里按返回先回到应用主页面，而不是直接退出应用。
     *
     * 必须注册在 {@code super.onCreate()} 之后——dispatcher 是"后注册先调用"。
     */
    private void registerBackHandling() {
        try {
            getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (goHomeFromConsole()) return;
                    // 不在控制台：让位给 Capacitor / 系统，保持原有行为。
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            });
            ServiceLog.i("返回键处理已注册（OnBackPressedDispatcher）");
        } catch (Throwable error) {
            ServiceLog.e("注册返回键处理失败", error);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // 老系统（Android 13 以下，或未启用预测性返回时）走这条。
        if (goHomeFromConsole()) return;
        super.onBackPressed();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // 单实例模式下，应用已经在前台时点通知走的是这里，不会再走 onCreate。
        setIntent(intent);
        openConsoleIfRequested(intent);
    }

    /**
     * 如果当前在控制台，就回到应用主页面。
     *
     * @return 是否处理了这次返回（true 表示已经回到主页面）
     */
    private boolean goHomeFromConsole() {
        if (!isShowingConsole()) return false;
        ServiceLog.i("返回：从控制台回到应用主页面");
        goHome();
        return true;
    }

    /**
     * @return WebView 当前是不是停在控制台页面
     */
    public boolean isShowingConsole() {
        if (showingConsole) return true;
        // 兜底：Activity 重建后标志会丢，这时按 URL 判断。
        try {
            if (getBridge() == null || getBridge().getWebView() == null) return false;
            String current = getBridge().getWebView().getUrl();
            if (current == null) return false;
            String base = Pairing.base(this);
            boolean matched = !base.isEmpty() && current.startsWith(base);
            if (matched) showingConsole = true;
            return matched;
        } catch (Throwable error) {
            return false;
        }
    }

    /** 供插件在打开控制台后调用，把状态标记上。 */
    public void noteConsoleShown() {
        showingConsole = true;
    }

    /** 把 WebView 载回应用内置的主页面。 */
    private void goHome() {
        showingConsole = false;
        runOnUiThread(() -> {
            try {
                String home = getBridge() != null ? getBridge().getLocalUrl() : null;
                if (home == null || home.isEmpty()) home = "https://localhost";
                ServiceLog.i("载入应用主页面：" + home);
                getBridge().getWebView().loadUrl(home);
            } catch (Throwable error) {
                ServiceLog.e("回到主页面失败", error);
            }
        });
    }

    /**
     * 供插件调用：把 WebView 载回应用主页面。
     *
     * 这里**不再检查** isShowingConsole——页面上的 ⌂ 按钮只会在控制台里出现，
     * 调用方已经确定了意图；多一道检查只会让"标志没对上"时按钮静默失效。
     *
     * @return 总是 true
     */
    public boolean goHomeFromPlugin() {
        ServiceLog.i("控制台请求返回应用主页面");
        goHome();
        return true;
    }

    /**
     * 按通知动作的要求把 WebView 导航到控制台。
     *
     * @param intent 启动或新到的 Intent
     */
    private void openConsoleIfRequested(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_OPEN_CONSOLE, false)) return;
        String url = Pairing.consoleUrlForApp(this);
        if (url.isEmpty()) {
            ServiceLog.w("通知动作要求打开控制台，但还没配对");
            return;
        }
        String hint = intent.getStringExtra(EXTRA_HINT);
        if (hint != null && !hint.isEmpty()) url = url + "#" + hint;
        final String target = url;
        ServiceLog.i("通知动作打开控制台：" + target);
        showingConsole = true;
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().loadUrl(target);
                }
            } catch (Throwable error) {
                ServiceLog.e("打开控制台失败", error);
            }
        });
    }

    /**
     * 让 WebView 躲开状态栏与下方导航栏。
     *
     * 背景：targetSdk 35 起 Android **强制** edge-to-edge，应用无法再退出这个模式
     * （{@code windowOptOutEdgeToEdgeEnforcement} 在 16 上已失效）。
     * 代价就是内容默认画到系统栏底下——顶部的标题栏被状态栏压住、底部的标签栏被导航栏压住。
     *
     * 正确做法不是"关掉"，而是**把系统栏占的位置让出来**：读 insets，作为内边距加到内容视图上。
     * 这样 WebView 的可视区域本身就避开了系统栏，网页里不需要再做任何特殊适配。
     *
     * 键盘也一并处理：edge-to-edge 下 {@code adjustResize} 不再自动顶起内容，
     * 所以把 IME 的高度也纳入底部内边距，否则给智能体发消息时输入框会被键盘挡住。
     *
     * @see #applySystemBarInsets
     */
    private void applySystemBarInsets() {
        try {
            View content = findViewById(android.R.id.content);
            if (content == null) {
                ServiceLog.w("找不到内容视图，跳过系统栏边距设置");
                return;
            }
            ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                // 底部取两者较大值：键盘弹起时导航栏 inset 通常变 0，用键盘高度顶上。
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return windowInsets;
            });

            // 界面是深色的，系统栏图标要用浅色，否则在深底上几乎看不见。
            WindowInsetsControllerCompat controller =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            controller.setAppearanceLightStatusBars(false);
            controller.setAppearanceLightNavigationBars(false);

            ViewCompat.requestApplyInsets(content);
            ServiceLog.i("已按系统栏 insets 让出边距（状态栏 / 导航栏 / 键盘）");
        } catch (Throwable error) {
            ServiceLog.e("设置系统栏边距失败", error);
        }
    }

    /** Android 13+ 发通知需要用户授权。 */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(
                this, new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
    }
}
