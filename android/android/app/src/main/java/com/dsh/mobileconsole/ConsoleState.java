package com.dsh.mobileconsole;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 从插件推来的快照里，挑出通知需要的那部分。
 *
 * 快照是 {@code /api/events} 的 SSE 里 {@code event: state} 那一帧的 data，形状见插件的
 * {@code bridge.snapshot()}。这里只做"读懂"，不做任何推断——拿不准的一律留空，
 * 免得通知上出现编造的状态。
 */
public final class ConsoleState {

    /** 一条待办（审批或提问）。 */
    public static final class Pending {
        public final String requestId;
        public final String kind;
        public final String sessionId;
        public final String toolName;
        public final String questionTitle;

        Pending(String requestId, String kind, String sessionId, String toolName, String questionTitle) {
            this.requestId = requestId;
            this.kind = kind;
            this.sessionId = sessionId;
            this.toolName = toolName;
            this.questionTitle = questionTitle;
        }

        public boolean isApproval() {
            return "approval".equals(kind);
        }
    }

    public int running = 0;
    public int idle = 0;
    public int offline = 0;
    public int clients = 0;
    public String runningTitle = "";
    public String runningText = "";
    public String balanceText = "";
    /** 极短形式的余额（如 "¥26.10"），给 Live Update 的芯片文字用。 */
    public String balanceShort = "";
    public final List<Pending> pendings = new ArrayList<>();

    /**
     * 解析一帧快照。
     *
     * @param json 快照 JSON
     * @return 状态对象；解析失败时返回一个空对象而不是抛异常
     */
    public static ConsoleState fromJson(JSONObject json) {
        ConsoleState state = new ConsoleState();
        if (json == null) return state;

        JSONObject server = json.optJSONObject("server");
        if (server != null) state.clients = server.optInt("clients", 0);

        state.balanceText = balanceText(json.optJSONObject("balance"));
        state.balanceShort = balanceShort(json.optJSONObject("balance"));

        JSONArray sessions = json.optJSONArray("sessions");
        if (sessions != null) {
            for (int index = 0; index < sessions.length(); index++) {
                JSONObject session = sessions.optJSONObject(index);
                if (session == null) continue;
                String status = session.optString("status", "");
                if ("running".equals(status)) {
                    state.running++;
                    if (state.runningTitle.isEmpty()) {
                        state.runningTitle = session.optString("title", "");
                        state.runningText = session.optString("lastText", "");
                    }
                } else if ("idle".equals(status)) {
                    state.idle++;
                } else if ("offline".equals(status)) {
                    state.offline++;
                }
            }
        }

        JSONArray pending = json.optJSONArray("pending");
        if (pending != null) {
            for (int index = 0; index < pending.length(); index++) {
                JSONObject item = pending.optJSONObject(index);
                if (item == null) continue;
                String requestId = item.optString("id", "");
                if (requestId.isEmpty()) continue;
                state.pendings.add(new Pending(
                        requestId,
                        item.optString("kind", ""),
                        item.optString("sessionId", ""),
                        item.optString("toolName", ""),
                        firstQuestionTitle(item.optJSONArray("questions"))
                ));
            }
        }
        return state;
    }

    /**
     * 问题列表里的第一句标题，用来在通知上说清"在问什么"。
     *
     * @param questions questions 数组
     * @return 标题；没有时为空串
     */
    private static String firstQuestionTitle(JSONArray questions) {
        if (questions == null || questions.length() == 0) return "";
        JSONObject first = questions.optJSONObject(0);
        if (first == null) return "";
        return first.optString("header", first.optString("question", ""));
    }

    /**
     * 把余额快照翻成一句话。
     *
     * 这必须和插件里 {@code describeBalance()} 的说法一致——同一个状态在两处显示成
     * 不同的话会让人以为哪里出错了。
     *
     * @param balance 余额对象
     * @return 描述
     */
    public static String balanceText(JSONObject balance) {
        if (balance == null) return "";
        String status = balance.optString("status", "");
        switch (status) {
            case "ready": {
                String currency = balance.optString("currency", "");
                String symbol = "CNY".equals(currency) ? "¥" : "USD".equals(currency) ? "$" : "";
                String amount = balance.optString("amount", "");
                String bonus = balance.isNull("bonus") ? null : balance.optString("bonus", null);
                if (bonus == null || bonus.isEmpty()) return "余额 " + symbol + amount;
                return "余额 " + symbol + amount + "（含赠送 " + symbol + bonus + "）";
            }
            case "signed-out":
                return "余额：未登录 DeepSeek 账户";
            case "unavailable":
                return "余额：宿主没有提供账户服务";
            case "empty":
                return "余额：账户里没有钱包";
            case "unknown":
                return "";
            default:
                return "余额：查询失败";
        }
    }

    /**
     * 余额的极短形式，用于 Live Update 芯片上的 "short critical text"。
     *
     * 芯片空间很小，只放金额本身（如 {@code ¥26.10}）；状态里说明性的前缀和赠送额度
     * 都留在正文里。
     *
     * @param balance 余额对象
     * @return 短文本；不可用时为空串
     */
    public static String balanceShort(JSONObject balance) {
        if (balance == null || !"ready".equals(balance.optString("status", ""))) return "";
        String currency = balance.optString("currency", "");
        String symbol = "CNY".equals(currency) ? "¥" : "USD".equals(currency) ? "$" : "";
        String amount = balance.optString("amount", "");
        return amount.isEmpty() ? "" : symbol + amount;
    }

    /**
     * 智能体状态摘要，例如 "🟢 1 运行中 · ⚪ 1 空闲"。
     *
     * @return 摘要
     */
    public String statusSummary() {
        StringBuilder builder = new StringBuilder();
        if (running > 0) builder.append("🟢 ").append(running).append(" 运行中");
        if (idle > 0) {
            if (builder.length() > 0) builder.append(" · ");
            builder.append("⚪ ").append(idle).append(" 空闲");
        }
        if (offline > 0) {
            if (builder.length() > 0) builder.append(" · ");
            builder.append("🔴 ").append(offline).append(" 离线");
        }
        return builder.length() == 0 ? "没有活跃会话" : builder.toString();
    }

    /**
     * 通知要展示的四种状态。
     *
     * 顺序即优先级：断联最要紧（什么都不通了），其次是待审批（在等人），
     * 然后是运行中，最后才是空闲。
     */
    public enum Kind {
        DISCONNECTED,
        APPROVAL,
        RUNNING,
        IDLE,
    }

    /**
     * 当前该显示哪种状态。
     *
     * @param connected 是否已连上电脑
     * @return 状态
     */
    public Kind kind(boolean connected) {
        if (!connected) return Kind.DISCONNECTED;
        if (!pendings.isEmpty()) return Kind.APPROVAL;
        if (running > 0) return Kind.RUNNING;
        return Kind.IDLE;
    }

    /**
     * 状态的大标题文字——就是岛上右边那行。
     *
     * @param connected 是否已连上电脑
     * @return 标题
     */
    public String stateTitle(boolean connected) {
        switch (kind(connected)) {
            case DISCONNECTED:
                return "未连接";
            case APPROVAL:
                return "待审批 · " + pendings.size();
            case RUNNING:
                return "运行中 · " + running;
            default:
                return "空闲";
        }
    }

    /**
     * 状态栏 chip 上的极短文字（位置很窄，越短越好）。
     *
     * @param connected 是否已连上电脑
     * @return 短文字
     */
    public String stateShort(boolean connected) {
        switch (kind(connected)) {
            case DISCONNECTED:
                return "断联";
            case APPROVAL:
                return "审批 " + pendings.size();
            case RUNNING:
                return "运行 " + running;
            default:
                return "空闲";
        }
    }

    /**
     * 通知的第二行：余额 + 待办。
     *
     * @return 摘要
     */
    public String summaryLine() {
        StringBuilder builder = new StringBuilder();
        if (!balanceText.isEmpty()) builder.append(balanceText);
        if (!pendings.isEmpty()) {
            if (builder.length() > 0) builder.append(" · ");
            int approvals = 0;
            for (Pending item : pendings) if (item.isApproval()) approvals++;
            if (approvals > 0) builder.append("⏳ ").append(approvals).append(" 个待审批");
            if (approvals != pendings.size()) {
                if (approvals > 0) builder.append(" · ");
                builder.append("❓ ").append(pendings.size() - approvals).append(" 个待回答");
            }
        }
        return builder.toString();
    }

    /**
     * 第一条待审批（通知上的"允许/拒绝"按钮作用在它上面）。
     *
     * @return 待办；没有待审批时返回 null
     */
    public Pending firstApproval() {
        for (Pending item : pendings) if (item.isApproval()) return item;
        return null;
    }
}
