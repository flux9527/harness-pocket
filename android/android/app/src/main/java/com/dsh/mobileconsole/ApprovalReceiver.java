package com.dsh.mobileconsole;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 通知上「允许 / 拒绝」按钮的落点。
 *
 * 严格说这是一个"没有界面的操作"：收到广播 → 后台线程回一个 POST → 结束。用户全程
 * 不需要打开应用，这正是从手机上批审批的意义。
 *
 * 为什么不在这里撤通知：待办通知的生命周期交给 {@link ConsoleService} 按其快照统一管。
 * 这样万一这次 POST 失败，待办还在快照里，通知也就还在，用户可以直接再点一次，
 * 而不是看着一条消失了但没生效的通知发愣。
 */
public class ApprovalReceiver extends BroadcastReceiver {

    public static final String ACTION_ANSWER = "com.dsh.mobileconsole.ANSWER";
    public static final String EXTRA_REQUEST_ID = "requestId";
    public static final String EXTRA_DECISION = "decision";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_ANSWER.equals(intent.getAction())) return;
        String requestId = intent.getStringExtra(EXTRA_REQUEST_ID);
        String decision = intent.getStringExtra(EXTRA_DECISION);
        if (requestId == null || decision == null) return;
        if (!"allow".equals(decision) && !"deny".equals(decision)) return;

        ServiceLog.i("通知动作：" + decision + " / " + requestId);

        final PendingResult pendingResult = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                boolean ok = ConsoleClient.answer(app, requestId, decision);
                ServiceLog.i(ok
                        ? "审批已提交给电脑：" + decision
                        : "提交失败，待办会保留在通知里可以重试");
                if (ok) Notifications.cancelPending(app, requestId);
            } finally {
                pendingResult.finish();
            }
        }, "dsh-answer").start();
    }
}
