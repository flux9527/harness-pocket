package com.dsh.mobileconsole;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 应用内日志。
 *
 * <h3>为什么要自己搞一套</h3>
 * 出问题时最有力的东西是 logcat，但要让用户插数据线跑 adb 才能看到——这在"手机上装个 APK 试试"
 * 的场景里等于没有。所以这里做一份**在应用里就能看、能复制、能导出**的日志：
 * <ul>
 *   <li>内存里保留最近 {@value #MAX_ENTRIES} 条，日志页增量拉取；</li>
 *   <li>同时落盘到 {@code filesDir/logs/app.log}（超过 512KB 轮转一份 .1），
 *       所以**杀进程重启后仍然能看到上一次的记录**——恰恰是排查"启动就失败"最需要的；</li>
 *   <li>{@link ServiceLog} 的每一次调用都会进这里，所以全应用没有漏网的日志。</li>
 * </ul>
 *
 * <h3>过时日志的清理</h3>
 * 落盘是为了排查，但没人的日志会一直长。所以提供两件事：
 * <ul>
 *   <li>{@link #purgeOutdated} —— 删掉轮转出来的旧文件，并把当前文件里超过保留天数的行去掉；
 *       由日志页的「清理过时日志」按钮触发，也可以手动调。</li>
 *   <li>{@link #isAutoPurge} —— 一个开关：打开后每次启动自动做一次上面这件事。</li>
 * </ul>
 *
 * 为了能按时间过滤，**文件里的每一行都带一个 epoch 毫秒前缀**（`epoch|可读内容`）。
 * 只靠 `MM-dd HH:mm:ss` 是没法跨年判断新旧、也没法解析的。
 *
 * 线程安全：后台 SSE 线程、主线程、广播接收器都会写。
 */
public final class AppLog {

    /** 内存里保留的条数。够回溯一次完整的"配对 → 连接 → 收通知"过程。 */
    private static final int MAX_ENTRIES = 500;

    /** 单个日志文件的大小上限，超过就轮转。 */
    private static final long MAX_FILE_BYTES = 512 * 1024;

    /** 默认保留天数。 */
    public static final int DEFAULT_KEEP_DAYS = 3;

    private static final String PREFS = "dsh_mobile_console_log";
    private static final String KEY_AUTO_PURGE = "auto_purge";
    private static final String KEY_KEEP_DAYS = "keep_days";

    private static final Object LOCK = new Object();
    private static final ArrayDeque<Entry> ENTRIES = new ArrayDeque<>();
    private static final SimpleDateFormat TIME = new SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US);

    private static long nextSeq = 0;
    private static File logDir;
    private static File logFile;
    private static volatile boolean ready = false;

    /** 一条日志。 */
    public static final class Entry {
        public final long seq;
        public final long time;
        public final String level;
        public final String tag;
        public final String message;

        Entry(long seq, long time, String level, String tag, String message) {
            this.seq = seq;
            this.time = time;
            this.level = level;
            this.tag = tag;
            this.message = message;
        }

        /** @return 给日志页看的一行文本 */
        public String line() {
            // SimpleDateFormat 不是线程安全的，而这条方法会被 SSE 线程、主线程、
            // 广播接收器同时调用，所以必须锁住。
            synchronized (LOCK) {
                return TIME.format(new Date(time)) + " " + level + "/" + tag + " " + message;
            }
        }

        /** @return 落盘用的一行：`epoch|可读内容`，epoch 用来按时间过滤。 */
        String fileLine() {
            return time + "|" + line();
        }
    }

    private AppLog() {}

    /**
     * 初始化：定位日志文件、读回上次运行的尾部、按需自动清理。
     *
     * @param context 上下文
     */
    public static void init(Context context) {
        if (ready) return;
        synchronized (LOCK) {
            if (ready) return;
            try {
                logDir = new File(context.getApplicationContext().getFilesDir(), "logs");
                if (!logDir.exists() && !logDir.mkdirs()) {
                    // 目录建不出来就只能内存里记，不能因此崩掉。
                    logDir = null;
                    ready = true;
                    return;
                }
                logFile = new File(logDir, "app.log");
            } catch (Throwable error) {
                logDir = null;
                logFile = null;
            }
            ready = true;
        }

        // 自动清理放在最后：它要读 prefs，而 prefs 调用本身不该影响日志系统初始化。
        //
        // 注意 purge 与 loadTail 是**二选一**：purgeOutdated 会把保留下来的条目读进内存，
        // 之后再 loadTail 读同一个文件就会得到重复条目。没有自动清理时才需要 loadTail。
        boolean purged = false;
        if (isAutoPurge(context)) {
            JSONObject result = purgeOutdated(context, keepDays(context));
            purged = true;
            add("I", "AppLog", "启动时自动清理过时日志：" + result.optString("summary", "完成"));
        }
        if (!purged) loadTail();
    }

    /** 把上次运行留下的日志尾部读回内存（最多半屏，够看清上次是怎么失败的）。 */
    private static void loadTail() {
        if (logFile == null || !logFile.exists()) return;
        try (RandomAccessFile reader = new RandomAccessFile(logFile, "r")) {
            long length = reader.length();
            long start = Math.max(0, length - 24 * 1024);
            reader.seek(start);
            byte[] buffer = new byte[(int) (length - start)];
            reader.readFully(buffer);
            String text = new String(buffer, StandardCharsets.UTF_8);
            String[] lines = text.split("\n");
            // 第一行可能是被截断的半行，丢掉。
            int from = start > 0 ? 1 : 0;
            synchronized (LOCK) {
                for (int index = from; index < lines.length; index++) {
                    Entry entry = parseLine(lines[index]);
                    if (entry != null) append(entry);
                }
            }
        } catch (Throwable error) {
            // 读不回来就算了，不影响本次运行。
        }
    }

    /**
     * 解析落盘的一行：`epoch|可读内容`。
     *
     * 兼容没有前缀的老格式（那时按"刚刚"处理），免得历史日志整块丢掉。
     *
     * @param raw 原始行
     * @return 条目；空行返回 null
     */
    private static Entry parseLine(String raw) {
        String line = raw == null ? "" : raw.trim();
        if (line.isEmpty()) return null;
        long time = System.currentTimeMillis();
        String body = line;
        int split = line.indexOf('|');
        if (split > 0) {
            try {
                time = Long.parseLong(line.substring(0, split));
                body = line.substring(split + 1);
            } catch (NumberFormatException ignored) {
                // 不是新格式，整行当内容。
            }
        }
        return new Entry(nextSeq++, time, "·", "上次", body);
    }

    /**
     * 记一条。
     *
     * @param level 级别：I / W / E
     * @param tag 标签
     * @param message 内容
     */
    public static void add(String level, String tag, String message) {
        Entry entry;
        synchronized (LOCK) {
            entry = new Entry(nextSeq++, System.currentTimeMillis(), level, tag, message);
            append(entry);
        }
        writeToFile(entry);
    }

    /** 只入内存（读回旧日志时用，别再写回文件造成重复）。 */
    private static void append(Entry entry) {
        ENTRIES.addLast(entry);
        if (ENTRIES.size() > MAX_ENTRIES) ENTRIES.removeFirst();
    }

    /** 追加到文件，必要时轮转。任何磁盘问题都不该影响功能。 */
    private static void writeToFile(Entry entry) {
        if (logFile == null) return;
        try {
            if (logFile.length() > MAX_FILE_BYTES) rotate();
            try (FileOutputStream stream = new FileOutputStream(logFile, true)) {
                stream.write((entry.fileLine() + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (IOException error) {
            // 写不进去就算了，内存里还有。
        }
    }

    /** 轮转：把当前文件挪成 app.log.1，挪不动就截断，总之不能无限增长。 */
    private static void rotate() {
        File rotated = new File(logDir, "app.log.1");
        if (rotated.exists() && !rotated.delete()) {
            truncate(logFile);
            return;
        }
        if (!logFile.renameTo(rotated)) truncate(logFile);
    }

    /** 把文件清空。 */
    private static void truncate(File file) {
        if (file == null) return;
        try (FileOutputStream stream = new FileOutputStream(file, false)) {
            stream.write(new byte[0]);
        } catch (IOException error) {
            // 忽略
        }
    }

    // ------------------------------------------------------------ 过时日志

    /**
     * 清理过时日志：删掉轮转出来的旧文件，并把当前文件里超过保留天数的行去掉。
     *
     * 内存里的条目也一并重建，否则日志页还会显示已经删掉的东西。
     *
     * @param context 上下文
     * @param keepDays 保留最近多少天（至少 1）
     * @return {@code {removedLines, removedFiles, keptLines, summary}}
     */
    public static JSONObject purgeOutdated(Context context, int keepDays) {
        int days = Math.max(1, keepDays);
        int removedFiles = 0;
        int removedLines = 0;
        int keptLines = 0;

        File dir = logDir;
        if (dir == null) {
            try {
                dir = new File(context.getApplicationContext().getFilesDir(), "logs");
            } catch (Throwable error) {
                dir = null;
            }
        }

        if (dir != null && dir.isDirectory()) {
            // 1) 轮转出来的文件整体是"过时"的，直接删。
            File[] olds = dir.listFiles((parent, name) -> name.startsWith("app.log.") && !name.equals("app.log"));
            if (olds != null) {
                for (File old : olds) {
                    if (old.delete()) removedFiles++;
                }
            }

            // 2) 当前文件按时间过滤后重写。
            File current = new File(dir, "app.log");
            if (current.exists()) {
                long cutoff = System.currentTimeMillis() - days * 24L * 60L * 60L * 1000L;
                List<String> keep = new ArrayList<>();
                List<Entry> keepEntries = new ArrayList<>();
                try {
                    byte[] bytes;
                    try (RandomAccessFile reader = new RandomAccessFile(current, "r")) {
                        bytes = new byte[(int) reader.length()];
                        reader.readFully(bytes);
                    }
                    String[] lines = new String(bytes, StandardCharsets.UTF_8).split("\n");
                    long seq = 0;
                    for (String line : lines) {
                        if (line.trim().isEmpty()) continue;
                        long time = System.currentTimeMillis();
                        String body = line;
                        int split = line.indexOf('|');
                        if (split > 0) {
                            try {
                                time = Long.parseLong(line.substring(0, split));
                                body = line.substring(split + 1);
                            } catch (NumberFormatException ignored) {
                                // 老格式：没有时间信息，按"刚刚"处理，保留。
                            }
                        }
                        if (time >= cutoff) {
                            keep.add(line);
                            keepEntries.add(new Entry(seq++, time, "·", "上次", body));
                            keptLines++;
                        } else {
                            removedLines++;
                        }
                    }
                } catch (Throwable error) {
                    // 读不动就别动它，宁可留着也不能把日志弄坏。
                    keep.clear();
                    keepEntries.clear();
                    removedLines = 0;
                    keptLines = -1;
                }

                if (keptLines >= 0) {
                    try (FileOutputStream stream = new FileOutputStream(current, false)) {
                        for (String line : keep) {
                            stream.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                        }
                    } catch (Throwable error) {
                        // 写失败就保持原样。
                    }
                    synchronized (LOCK) {
                        // 内存里也重建：否则日志页还会显示已经删掉的东西。
                        // 读回来的条目用低序号，新条目仍从 nextSeq 继续，顺序不会乱；
                        // 页面那边在清理后会重置增量位置，重新拉一遍。
                        ENTRIES.clear();
                        for (Entry entry : keepEntries) append(entry);
                    }
                }
            }
        }

        JSONObject result = new JSONObject();
        try {
            result.put("removedLines", removedLines);
            result.put("removedFiles", removedFiles);
            result.put("keptLines", Math.max(0, keptLines));
            result.put("keepDays", days);
            result.put("summary", "保留最近 " + days + " 天，删除 " + removedFiles + " 个旧文件、" + removedLines + " 行旧记录");
        } catch (Throwable error) {
            // 忽略
        }
        return result;
    }

    /**
     * 是否在启动时自动清理过时日志。默认**打开**：日志本来就是为了排查，
     * 无上限增长对谁都没好处；保留天数（默认 3 天）也足够覆盖"昨天还好好的"这种场景。
     *
     * @param context 上下文
     * @return 是否自动清理
     */
    public static boolean isAutoPurge(Context context) {
        try {
            return prefs(context).getBoolean(KEY_AUTO_PURGE, true);
        } catch (Throwable error) {
            return true;
        }
    }

    /**
     * 设置启动时是否自动清理。
     *
     * @param context 上下文
     * @param enabled 是否开启
     */
    public static void setAutoPurge(Context context, boolean enabled) {
        try {
            prefs(context).edit().putBoolean(KEY_AUTO_PURGE, enabled).apply();
        } catch (Throwable error) {
            // 忽略
        }
    }

    /**
     * 保留天数。
     *
     * @param context 上下文
     * @return 天数（至少 1）
     */
    public static int keepDays(Context context) {
        try {
            return Math.max(1, prefs(context).getInt(KEY_KEEP_DAYS, DEFAULT_KEEP_DAYS));
        } catch (Throwable error) {
            return DEFAULT_KEEP_DAYS;
        }
    }

    /**
     * 设置保留天数。
     *
     * @param context 上下文
     * @param days 天数
     */
    public static void setKeepDays(Context context, int days) {
        try {
            prefs(context).edit().putInt(KEY_KEEP_DAYS, Math.max(1, Math.min(365, days))).apply();
        } catch (Throwable error) {
            // 忽略
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------ 读取与导出

    /**
     * 取 seq 大于指定值的条目。
     *
     * @param sinceSeq 上次拿到的最大 seq（首次传 0）
     * @return 条目列表
     */
    public static List<Entry> snapshot(long sinceSeq) {
        List<Entry> result = new ArrayList<>();
        synchronized (LOCK) {
            for (Entry entry : ENTRIES) {
                if (entry.seq > sinceSeq) result.add(entry);
            }
        }
        return result;
    }

    /**
     * 导出成 JSON 数组，供原生桥返回给页面。
     *
     * @param sinceSeq 上次拿到的最大 seq
     * @return JSON
     */
    public static JSONArray toJson(long sinceSeq) {
        JSONArray array = new JSONArray();
        for (Entry entry : snapshot(sinceSeq)) {
            JSONObject item = new JSONObject();
            try {
                item.put("seq", entry.seq);
                item.put("time", entry.time);
                item.put("date", TIME.format(new Date(entry.time)));
                item.put("level", entry.level);
                item.put("tag", entry.tag);
                item.put("message", entry.message);
            } catch (Throwable error) {
                // JSONObject.put 在 Android 上不会抛，保险起见还是包一层。
            }
            array.put(item);
        }
        return array;
    }

    /**
     * 当前最大 seq，页面用它做增量拉取。
     *
     * @return seq
     */
    public static long lastSeq() {
        synchronized (LOCK) {
            return nextSeq - 1;
        }
    }

    /** 全部日志拼成一段文本，供"复制/导出"。 */
    public static String asText() {
        StringBuilder builder = new StringBuilder();
        synchronized (LOCK) {
            for (Entry entry : ENTRIES) builder.append(entry.line()).append('\n');
        }
        return builder.toString();
    }

    /** 清空内存与磁盘日志。 */
    public static void clear() {
        synchronized (LOCK) {
            ENTRIES.clear();
        }
        truncate(logFile);
        add("I", "AppLog", "日志已清空");
    }
}
