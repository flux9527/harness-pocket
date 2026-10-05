package com.dsh.mobileconsole;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import java.security.MessageDigest;

/**
 * 读本应用的签名证书指纹。
 *
 * 为什么要这个：小米超级岛的接入流程里明确有一步「配置指纹证书」——开发者要在小米开发者后台
 * 登记 App 的签名指纹。而调试签名和正式签名是两套指纹，真要提交时还得换成正式签名的包。
 * 与其让人装个工具去算，不如应用自己把指纹显示出来。
 *
 * 同时给出 MD5 与 SHA-256：不同平台要的不一样，小米那边 historically 两种都见过。
 */
public final class AppSignature {

    private AppSignature() {}

    /** 指纹结果。任一字段拿不到时是空串。 */
    public static final class Info {
        public String md5 = "";
        public String sha1 = "";
        public String sha256 = "";

        /** @return 是否至少拿到一组指纹 */
        public boolean ok() {
            return !sha256.isEmpty();
        }

        /** @return 给诊断页用的一行摘要 */
        public String summary() {
            if (!sha256.isEmpty()) return "SHA-256 " + sha256;
            return "读不到签名指纹";
        }
    }

    /**
     * 取本应用的签名指纹。
     *
     * @param context 上下文
     * @return 指纹
     */
    public static Info read(Context context) {
        Info info = new Info();
        try {
            PackageManager manager = context.getPackageManager();
            String packageName = context.getPackageName();
            Signature[] signatures;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo packageInfo = manager.getPackageInfo(
                        packageName, PackageManager.GET_SIGNING_CERTIFICATES);
                if (packageInfo.signingInfo == null) return info;
                signatures = packageInfo.signingInfo.getApkContentsSigners();
            } else {
                PackageInfo packageInfo = manager.getPackageInfo(
                        packageName, PackageManager.GET_SIGNATURES);
                signatures = packageInfo.signatures;
            }

            if (signatures == null || signatures.length == 0) return info;
            byte[] raw = signatures[0].toByteArray();
            info.md5 = digest("MD5", raw);
            info.sha1 = digest("SHA1", raw);
            info.sha256 = digest("SHA-256", raw);
        } catch (Throwable error) {
            ServiceLog.w("读取签名指纹失败：" + error);
        }
        return info;
    }

    /**
     * 算某个摘要并格式化成大写冒号分隔。
     *
     * @param algorithm 算法名
     * @param data 数据
     * @return 形如 {@code AB:CD:EF:...}；失败时空串
     */
    private static String digest(String algorithm, byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance(algorithm);
            byte[] bytes = md.digest(data);
            StringBuilder builder = new StringBuilder(bytes.length * 3);
            for (int index = 0; index < bytes.length; index++) {
                if (index > 0) builder.append(':');
                builder.append(String.format("%02X", bytes[index]));
            }
            return builder.toString();
        } catch (Throwable error) {
            return "";
        }
    }
}
