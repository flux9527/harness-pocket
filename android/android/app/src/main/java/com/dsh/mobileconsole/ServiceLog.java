package com.dsh.mobileconsole;

import android.util.Log;

/**
 * 统一日志：一份进 logcat，一份进 {@link AppLog}。
 *
 * 转发到 AppLog 之后，**应用内的日志页就能看到全部内容**，不需要插数据线跑 adb——
 * 这正是"装到手机上试试但其实看不到发生了什么"时最缺的东西。所有既有调用点都不用改。
 */
public final class ServiceLog {

    private static final String TAG = "DshMobileConsole";

    private ServiceLog() {}

    public static void i(String message) {
        Log.i(TAG, message);
        AppLog.add("I", TAG, message);
    }

    public static void w(String message) {
        Log.w(TAG, message);
        AppLog.add("W", TAG, message);
    }

    public static void e(String message) {
        Log.e(TAG, message);
        AppLog.add("E", TAG, message);
    }

    /**
     * 记一个异常。带上类型、消息，以及栈的头几帧——应用内日志页没法折叠，
     * 整条栈会淹掉真正有用的那两行。
     *
     * @param message 说明
     * @param error 异常
     */
    public static void e(String message, Throwable error) {
        String detail = message + " -> " + error;
        Log.e(TAG, detail, error);
        AppLog.add("E", TAG, detail + " @" + firstFrames(error));
    }

    /**
     * 取栈的前几帧。
     *
     * @param error 异常
     * @return 形如 {@code MainActivity.java:42 ← ConsoleService.java:118}
     */
    private static String firstFrames(Throwable error) {
        if (error == null) return "";
        StackTraceElement[] frames = error.getStackTrace();
        StringBuilder builder = new StringBuilder();
        int limit = Math.min(3, frames.length);
        for (int index = 0; index < limit; index++) {
            if (index > 0) builder.append(" ← ");
            builder.append(frames[index].getFileName()).append(':').append(frames[index].getLineNumber());
        }
        return builder.toString();
    }
}
