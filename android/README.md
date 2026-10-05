# harness-pocket-android

[dsh-mobile-console](../plugin) 的 Android 客户端：**后台常驻接状态、Android 16 原生 Live Updates 通知、直接在通知上批审批**。

配套的电脑端是一个 DSH 插件（在 `../plugin`），它在局域网里起一个小服务。
这个应用就是那台"手机"的原生版本——比浏览器多出两件浏览器做不到的事：**息屏后连接不断**，以及**通知上直接操作**。

```
┌─ 手机 ────────────────────────────────┐        ┌─ 电脑（DSH 插件，0.0.0.0:8799）─┐
│ ConsoleService（前台服务）             │        │                                │
│   └── SSE 长连接 ─────────────────────┼──HTTP──▶ /api/events（快照推送）        │
│ Live Updates 通知：状态 + 余额 + 待办   │        │ /api/answer（允许 / 拒绝）      │
│   └── 「允许 / 拒绝」按钮 ────────────┼──HTTP──▶                                │
│ WebView（复用插件的手机界面）           │        │                                │
└───────────────────────────────────────┘        └────────────────────────────────┘
```

---

## 能力

| 能力 | 说明 |
| --- | --- |
| **后台实时接收** | 前台服务抱一条 SSE 长连接，断线指数退避重连（1s → 30s）。息屏、切到别的应用都不影响。 |
| **Android 16 原生 Live Updates** | API 36 上用 `Notification.ProgressStyle` + `setRequestPromotedOngoing(true)`，被系统提升为"实时更新"。 |
| **通知里看智能体状态** | 常驻通知显示：运行中/空闲/离线数量、当前会话在输出什么、待办数量。 |
| **通知里看余额** | 余额来自电脑端插件（它从 DSH 宿主的账户服务取），随快照一起推过来。 |
| **通知上批审批** | 待审批的通知带「允许 / 拒绝」按钮，点一下直接回传，**不用打开应用**。 |
| **复用网页界面** | 配对后在 WebView 里加载电脑上的手机界面，不做第二套 UI。 |

### Live Updates 在低版本上怎么办

Android 16（API 36）以下没有 Live Updates（`ProgressStyle` / 提升常驻通知都是 API 36 才有的）。
低版本上它会退化成一条普通的常驻通知——**信息一点不少**，因为状态、余额、待办本来就写在标题和副标题里，
进度样式只是锦上添花。代码里所有 API 36 调用都在版本判断内，且外面再套了一层兜底 catch，
不会因为某个 OEM 的实现有出入就把服务搞崩。

---

## 各家「灵动岛」到底能覆盖到什么程度

这不是一句「全都兼容」能带过的事。先说结论：**只有走 Android 16 官方标准的通道是普通应用开箱可用的**，
剩下那些厂商私有通道基本都要先过厂商的审批。

| 平台 | 机制 | 本应用的情况 |
| --- | --- | --- |
| **Android 16 / Pixel** | 官方 Live Updates | ✅ 已实现。**但还差用户侧的一个开关**（见下） |
| **OPPO ColorOS 16 流体云** | 官方走开放路线，声明完整接入原生 Android 16 Live Updates API | ✅ 走标准通道 |
| **三星 Now Bar** | 基于标准通知；且**按应用类别**逐步开放（One UI 9 才新增三类） | ⚠️ 标准通道能进，但上不上岛由三星的类别名单决定 |
| **荣耀 灵动胶囊** | —— | ❌ **至今未支持**原生 Android 16 实时通知 API |
| **小米 HyperOS 超级岛** | 厂商私有 extras（`miui.focus.param`） | ⚠️ 已实现，但**需要先申请焦点通知权限**（见下） |
| **华为 实况窗** | 需申请「实况窗服务权益」 | ❌ 普通 APK 无法自办 |
| **vivo 原子通知** | 需 vivo 开放平台开通 | ❌ 同上 |

**荣耀那条要特别说明**：我早先看到「荣耀灵动胶囊兼容 Live Updates」的标题就下了结论，**这是错的**。
荣耀社区里能查到的是——2025-12 用户请求荣耀跟进 OPPO 的开放方案，2026-03 又有人请求支持，
荣耀 MagicOS 产品经理只回了「在做的」，另有用户反馈「上个月就说在开发中了，然后就没动静了」。
**也就是说：到今天为止，荣耀还没有开放这条通道。** 不要指望它能亮。

**小米那条也要说清楚**：虽然文档给了客户端实现方式，看起来不需要 MIPUSH，但接入**不是写代码就行**。
小米官方的接入流程是：

1. 注册成为小米开发者；
2. 创建并**上架** App；
3. 在开发者管理页面选择要开通超级岛的应用；
4. **配置指纹证书**；
5. **上岛场景预审**；
6. 正式方案审核通过后才能开发和联调联试；
7. 联调联试期间通过**设备白名单**申请上线验证；
8. 提交通过测试的**正式环境 APK**；
9. 拿到正式权限后灰度放量，上线后约 7~15 天全量。

也就是说：**侧载的调试包在这条路上走不通**。要上小米超级岛，得先把 App 正经上架、把签名证书指纹登记上去，
并且内容要按《小米超级岛模板库》绘制（图片单张 ≤100k、必须 HTTPS、宽高比 1.78–1:1）。

本应用的做法是：探测到没有该权限就不附加岛参数（安全降级），
**等你哪天走完流程拿到权限，代码这边不用改就会自动生效**。
诊断页会把**签名指纹（SHA-256 / MD5）**直接算出来，真要提交时不用另找工具。

> 所以现实是：**标准通道是唯一开箱可用的**，OPPO 走标准通道没问题；荣耀还没开；
> 小米/华为/vivo 都要申请。这不是代码问题，是厂商准入问题，我不会假装能绕过。

### 「上岛」到底靠哪几个调用（这一节是踩坑实录）

**先说结论**：靠的是 androidx 的 `NotificationCompat.Builder` 上的三个方法，
**不是**平台 `Notification.Builder` 上的 `ProgressStyle` + `setFlag`。

| 调用 | 作用 |
| --- | --- |
| `setRequestPromotedOngoing(true)` | **决定性的一步**：向系统请求把这条常驻通知提升为实时更新 |
| `setShortCriticalText("¥26.10")` | 状态栏 chip 上那行极短文字 |
| `NotificationCompat.ProgressStyle` + `setStyledByProgress(true)` + `setProgress(n)` | 岛上的**进度条** |
| `addAction(0, "允许", intent)` | 岛上的**操作按钮** |
| `setCategory(CATEGORY_PROGRESS)` + `setOngoing(true)` + `setOnlyAlertOnce(true)` | 类别与常驻语义 |

**我在这上面走了很大一段弯路，值得记下来：**

一开始我在**平台** `Notification.Builder` 里用 `javap` 逐条查，确认它**没有**
`setRequestPromotedOngoing`，于是改用平台的 `Notification.ProgressStyle` +
`setFlag(FLAG_PROMOTED_ONGOING)`——结果就是"通知发出来了，但不是灵动岛"。

后来读两个**真机上确实能上岛**的开源实现才明白：
它们走的是 **`androidx.core.app.NotificationCompat.Builder`**，那上面
`setRequestPromotedOngoing` 和 `setShortCriticalText` 两个方法**都有**，
而且 androidx 也有自己的 `NotificationCompat.ProgressStyle`。

我当初换掉 builder 的理由是「平台的 `Notification.ProgressStyle` 塞不进 Compat builder」——
这个理由本身没错，但**结论错了**：正确做法是把 `ProgressStyle` 也换成 androidx 的同名类，
而不是因为一个类不匹配就把整个 builder 换掉，那等于连提升能力一起丢了。

**教训：androidx 一条路走到底，平台类和 Compat 类不要混用。**

参考实现（都可直接读源码）：

- [rikkahub](https://github.com/rikkahub/rikkahub) —— `utils/NotificationUtil.kt`、`service/ChatNotificationManager.kt`
- [InstallerX-Revived](https://github.com/wxxsfxyzm/InstallerX-Revived) —— `framework/notification/builder/ModernNotificationBuilder.kt`（实时更新 + 进度条 + 按钮）、`MiIslandNotificationBuilder.kt`（小米超级岛）

### 用户侧开关：不是调了 API 就一定生效

Android 16 的实时更新另有一个**用户侧的应用级开关**，由
`NotificationManager.canPostPromotedNotifications()` 报告。
平台清单里**没有**对应权限可以声明（我在 `android.jar` 的全部 14589 个条目里、
按 UTF-8 与 UTF-16 两种编码扫过，确实没有），程序改不了，只能引导用户去点。

现在的处理：

- 用 `canPostPromotedNotifications()` 判断；
- 不允许时，通知照发（普通常驻通知，信息一点不少），并**在通知上挂一个「开启实时更新」动作**，
  一键跳到 `android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS`
  （这个 action 常量是从 `android.jar` 里 `javap` 查出来的）。

顺带说明：manifest 里声明了 `POST_PROMOTED_NOTIFICATIONS`，但**当前 API 36 SDK 里平台并不认识它**
（全条目扫描 0 命中）。声明它不花任何代价、将来真出现了就自动生效；但**不在运行时请求**它。

服务启动时会把整条链路的状态打进 logcat，一眼看清卡在哪一环：

```
通知通道：Android 16（API 36）；标准 Live Updates=true；实时更新开关（提升权限）=false；小米超级岛可用=false（协议版本 0）
```

### 小米超级岛是怎么接的

依据小米澎湃OS 开发者平台《小米超级岛 - 开发指南》的**客户端实现**路径（不需要 MIPUSH）：

1. 正常构建一条原生通知；
2. 往 `notification.extras` 里放：
   - `miui.focus.param`：一段 JSON（`param_v2` 里含岛交互、大岛 / 小岛内容、`baseInfo` 焦点通知文案）；
   - `miui.focus.pics`：岛要用的图标（`Icon.createWithResource`）；
   - `miui.focus.actions`：`Notification.Action`，岛上的「允许 / 拒绝」直接引用它们。
3. 发通知。

两条通知都做了适配：

- **常驻状态通知**：`islandFirstFloat=false` / `enableFloat=false`——**不抢焦点**，安静地待在岛上；
  `updatable=true` 让状态更新能刷新岛内容。
- **待审批通知**：`islandFirstFloat=true`——审批是等人的事，一次弹出到展开态，岛上带「允许 / 拒绝」，
  用的是和普通通知里**完全相同的那两个 `PendingIntent`**，行为一致。

另外按官方 FAQ 守住了两个硬约束：

- `miui.focus.param` **不得超过 3072 字节**。超了就整条不附加，而不是截断字符串——
  截断 JSON 可能得到不合法结构，那种情况下 ROM 的表现更不可控。
- 文案长度按 FAQ 的限制收短（岛上 A/B 区各约 4 个汉字），超长文本会先截断再进参数。

**只在能力探测通过时才附加**，三重条件全满足才动手：

```java
persist.sys.feature.island          // 系统开了岛特性（反射 SystemProperties）
notification_focus_protocol >= 2    // OS2 起才有焦点通知
canShowFocus                        // 用户没关掉本应用的焦点通知权限（向 SystemUI 查询）
```

任何一步失败、或者拼参数抛异常，都只是**不加岛参数**——普通通知本身不受影响（改的是同一个
Notification 上的 extras，别的字段照旧）。这一点是刻意的：厂商字段随 ROM 版本变，而模板库细节在
一份单独的 PDF 里，我拿不到全部字段，所以选择「宁可岛不显示，也不能让通知坏掉」。

服务启动时会往 logcat 打一行能力自检，一眼看出这台机器走哪条通道：

```
通知通道：Android 16（API 36）；标准 Live Updates=true；小米超级岛可用=false（协议版本 0）
```

排查时：`adb logcat -s DshMobileConsole`

---

## 构建

### 前置

- **JDK 17+**（本仓库用 JDK 21 构建通过。注意 `JAVA_HOME` 要指向真实存在的 JDK）
- **Android SDK**：`platforms;android-36`、`build-tools;36.0.0`、`platform-tools`
- **网络**：Maven Central 与 `dl.google.com` 可访问

### 需要自备的环境

仓库里**不含**工具链（Android SDK、Gradle 缓存加起来约 1.8 GB，不适合放进 git）。
你需要自己准备：

| 需要 | 说明 |
| --- | --- |
| JDK 21 | `JAVA_HOME` 指过去 |
| Android SDK | 需要 **platform 36** 与 **build-tools 36.0.0**；用 Android Studio 打开工程时它会自动装 |
| 网络 | Maven Central 与 `dl.google.com` 可访问 |

配置 SDK 有两条路：

- **用 Android Studio 打开 `android/android`**（推荐）——它会自己写好 `local.properties`，不用设环境变量；
- **命令行构建**——按下面设环境变量，或自己写一份 `android/android/local.properties`：

```properties
sdk.dir=<你的 Android SDK 路径>
```

> `local.properties` 是本机专属文件，已被 `.gitignore` 排除，不要提交。

### 构建命令

仓库里不含 `node_modules`，**第一次构建要先装依赖**，否则 `npx cap` 那步会失败：

```powershell
$env:JAVA_HOME='<JDK 21 路径>'
$env:ANDROID_HOME='<Android SDK 路径>'
$env:GRADLE_USER_HOME='<Gradle 缓存路径，可留空用默认>'   # 可选
$env:ANDROID_USER_HOME='<Android 用户目录>'              # ← 别漏，见下

cd harness-pocket\android
pnpm install                  # 或 npm install；仓库带 pnpm-lock.yaml
npx cap copy android          # ← 别省这一步，见下
cd android
.\gradlew.bat assembleDebug
```

> 不想分步的话，`package.json` 里有个 `build:apk` 脚本，等价于 `cap sync` + `gradlew assembleDebug`。

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

> **`ANDROID_USER_HOME` 设了就要一直用同一个值。** 调试签名用的 `debug.keystore`
> 建在这个目录下；换一个值就等于换了一个位置，AGP 找不到就直接
> `Task :app:validateSigningDebug FAILED` 报出来。我漏设过一次，正好撞上。

> **改完 `www/` 或 `capacitor.config.json` 一定要先 `cap copy`。**
> Android 工程用的是 `android/app/src/main/assets/public/` 里的**副本**，不是 `www/` 本身；
> 直接跑 `gradlew` 打出来的包仍然是旧界面。这个坑我踩过：界面和 `allowNavigation` 的改动
> 都没进包，白打了两轮。`package.json` 里的 `build:apk` 脚本带了 `cap sync`，用它就不会漏。

### 关于 Gradle 发行版地址

`android/gradle/wrapper/gradle-wrapper.properties` 里的 `distributionUrl` 指向**腾讯镜像**。
原因：这台机器上 `services.gradle.org` 的 CDN 连不上（`connect timeout`，Node 与 JVM 都试过），
而镜像给的是同一份官方产物。你的网络能直连官方的话，把那一行换回去即可（文件里有注释）。

### 用 Android Studio 打开

直接用 Android Studio 打开 `android/android` 目录即可。它也是标准的 Gradle 工程。

---

## 发布与签名

### 为什么不能直接发 `assembleDebug` 的包

调试包有三个**实质性的安全问题**，而这个应用存着配对口令并能在你电脑上批命令，
把这样的包发出去等于把用户电脑交出去：

| 标志 | 调试包的值 | 后果 |
| --- | --- | --- |
| `android:debuggable` | `true` | 任何人挂上调试器就能 dump 出 SharedPreferences 里的**配对令牌** |
| 签名证书 | `CN=Android Debug` | 调试密钥库的口令是公开的 `android`，**谁都能签一个"更新"覆盖安装** |
| `android:allowBackup` | `true` | 配对令牌会跟着云备份走、也能被 `adb backup` 拉走 |

三处都已修：`allowBackup` 在 manifest 里改成 `false`（并补了 Android 12+ 的
`dataExtractionRules`——光靠 `allowBackup=false` 挡不住设备间直传），
`debuggable` 和签名则由 release 构建类型解决。

### 生成自己的密钥库

```bash
keytool -genkeypair -v \
  -keystore android/android/keystore/release.jks \
  -alias harness-pocket -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype PKCS12 -dname "CN=你的名字, O=你的组织, C=CN"
```

> **证书主体（`-dname`）会公开在 APK 里**，所以别写私人邮箱、手机号之类的。
> 本项目发布产物用的主体只有项目名和组织名（`C=CN`），不含任何个人信息。

然后在 `android/android/keystore.properties` 里写好：

```properties
storeFile=../keystore/release.jks
storePassword=你的口令
keyAlias=harness-pocket
keyPassword=你的口令
```

`keystore.properties` 与 `*.jks` 都在 `.gitignore` 里，不会被提交。

> ⚠️ **这份密钥库必须备份。** 丢了就没法再发布同签名的更新——用户会因为签名不一致
> **装不上**你的新版本，只能卸载重装。真需要换密钥时，v3 签名方案支持"密钥轮换"，
> 所以构建里显式开了 v3（见下）。

### 构建

```bash
cd android/android
./gradlew.bat assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

没有 `keystore.properties` 时，release 会构建成**未签名**产物：能构建成功但装不上。
这里刻意**不退回调试签名**——那会让人以为打出了正式包，是最糟的结果。

### 签名方案为什么是 v2 + v3

构建里显式写死，不依赖默认值：

- **v1 关掉**——它是给 Android 7.0 以下用的，而 `minSdk` 已经是 24，
  而 v2 正是 Android 7.0 引入的，所以 v2 就够覆盖全部支持版本；
- **v3 打开**——它支持密钥轮换。哪天真需要换签名密钥（比如担心泄露），
  有 v3 才能发布"新旧密钥都有证明"的更新，否则老用户只能卸载重装。

### 换签名要卸载重装

调试包和正式包**签名不同**，Android 不允许覆盖安装。从调试版切到正式版时：

```bash
adb uninstall com.dsh.mobileconsole
# 或者手机上先手动卸载
```

之后的版本升级只要用同一个密钥库签名，就能正常覆盖安装。

---

## 安装与配对

1. 把 `app-debug.apk` 传到手机上安装（debug 签名，需要允许"安装未知来源应用"）。
2. 打开应用，首次启动会弹通知权限——**必须允许**，否则通知和审批按钮都不存在。
3. 在电脑上的 DSH 里执行 `/mobile url`，把输出的整段地址复制到应用的配对框里。
   - 地址形如 `http://192.168.1.5:8799/?k=<32位令牌>`，**令牌就在里面**，别只复制到端口。
   - 也可以只粘贴 `192.168.1.5:8799/?k=...`（省略 `http://` 会自动补上）。
4. 点「配对并启动后台服务」。之后状态栏会出现一条常驻通知。
5. 在电脑上对要接管的会话执行 `/mobile on`，审批与提问才会转到手机。

> 会话必须**已武装**才会被接管。没武装的会话，行为和不装插件时完全一样。

---

## 应用内诊断与日志

把 APK 装到手机上试的时候，**看不到任何东西**——没有 adb、没有 logcat。所以应用自带了两页。

### 诊断页

点一下「运行诊断」，逐条查完并给**一句结论**：

| 检查 | 说明 |
| --- | --- |
| 配对信息 | 地址与令牌解析出来了没有 |
| 通知权限 | 被关掉的话，任何通知都不会出现 |
| **实时更新开关** | `canPostPromotedNotifications()`；**「已经是 Android 16 但不是灵动岛」最常见的原因** |
| 厂商通道 | 小米设备会报焦点通知协议版本与权限是否到位，并列出小米那套接入流程 |
| **签名指纹** | SHA-256 / MD5；小米接入流程要「配置指纹证书」，这里直接算好 |
| 后台服务 | 前台服务有没有真的跑起来 |
| 连接电脑 | 真去 `GET /api/state`，报 HTTP 状态与会话数；连不上会说清是 Wi-Fi 还是防火墙 |

结论会直说，例如：

```
结论：这台手机是 Android 14（API 34），标准实时更新需要 Android 16（API 36）
——在这个系统上不可能出现灵动岛。（荣耀灵动胶囊目前尚未开放原生实时通知 API；
华为实况窗、vivo 原子通知需要各自的权益申请）
```

系统支持但开关没开时，页面底部会出现「去打开系统『实时更新』开关」按钮。

### 日志页

- 全部日志（`ServiceLog` 的每一次调用都进池子，没有漏网的）；
- 支持**复制全部**，直接发给我就能定位；
- 同时落盘到 `filesDir/logs/app.log`（超 512KB 轮转），**杀进程重启后仍然在**——
  「启动就失败」这种情况恰恰最需要看到上一次的记录。

日志页停在前面时每 2 秒增量拉取，`E` 级标红、`W` 级标黄。

**过时日志清理**（日志页底部）：

- **「清理过时日志」按钮** —— 删掉轮转出来的旧文件（`app.log.1` 等），
  并把当前文件里超过保留天数的行去掉；做完会告诉你删了几个文件、几行记录。
- **「启动时自动清理过时日志」开关** —— 打开后每次启动自动做一次上面这件事，**默认打开**。
  保留天数默认 3 天（可以在代码里 `AppLog.setKeepDays` 调）。

为了能按时间过滤，**文件里每一行现在带一个 epoch 毫秒前缀**（`epoch|可读内容`）。
只靠 `MM-dd HH:mm:ss` 是没法跨年判断新旧、也没法可靠解析的。
读取时兼容没有前缀的老格式，不会把历史日志整块丢掉。

---

## 通知长什么样

**常驻（Live Update）**

```
DSH 智能体
🟢 2 运行中 · ⚪ 1 空闲
余额 ¥42.50（含赠送 ¥5.00） · ⏳ 1 个待审批
<展开还能看到当前会话最近的一段输出>
```

**待审批**

```
需要审批：pwsh
点「允许」直接放行，点「拒绝」直接拦下——不用打开电脑。
[ 允许 ]  [ 拒绝 ]
```

「允许」等同于在电脑上点允许——需要越权的操作会**真的执行**。「拒绝」会把它拦下。

**未开启实时更新时**（Android 16 上那个用户侧开关是关的）常驻通知会多一个动作：

```
DSH 智能体
🟢 2 运行中 · ⚪ 1 空闲
余额 ¥42.50（含赠送 ¥5.00） · ⏳ 1 个待审批
[ 开启实时更新 ]
```

点它直接跳到系统的「实时更新」设置页。开之前通知照样能看，只是不会被系统提升成实时更新。
已在小米设备上探测到焦点通知权限时，同一枚通知还会带上超级岛参数（见上文）。

### 岛上的布局

上岛之后这条常驻通知长这样：

| 位置 | 内容 |
| --- | --- |
| **左边** | 状态图标，随状态变：▶ 运行中 / ❗ 待审批 / ○ 空闲 / ⊘ 已断联 |
| **右边** | 状态文字（通知大标题）：`运行中 · 2` / `待审批 · 1` / `空闲` / `未连接` |
| 状态栏 chip | 极短的状态：`运行 2` / `审批 1` / `空闲` / `断联` |
| 展开 · 正文 | 余额与待办：`余额 ¥42.50（含赠送 ¥5.00） · ⏳ 1 个待审批` |
| 展开 · 副标题 | 会话计数：`🟢 2 运行中 · ⚪ 1 空闲` |
| 展开 · 进度条 | 运行中会话占比（0 = 全空闲，100 = 全在跑） |
| 展开 · 按钮 | 待审批时 `允许` `拒绝`；恒有 `停止` `发消息` |

状态优先级：**断联 > 待审批 > 运行中 > 空闲**——断联最要紧，其次是有人在等你。

> **图标一律用纯白填充（`#FFFFFFFF`）。** Android 的通知小图标只取 alpha 通道、
> 由系统负责着色，所以颜色本来"不应该"有影响——但厂商的岛实现未必会重新着色，
> 直接拿原图渲染时，黑色图标落在深色岛上就等于看不见。白色两种情况下都成立。
>
> 图形也特意做粗：圆环壁厚 4dp、感叹号用实心圆挖空，
> 因为 chip 上那个位置实际只有十几 dp，细线条会糊成一团。
> 几何是**真的渲染出来看过**的（机器上没有 SVG 渲染器，写了个解析 pathData 的脚本自己渲，
> 含圆弧与 evenOdd 挖空），预览图在 [`../dist/icons-preview.png`](../dist/icons-preview.png)。

**「停止」和「发消息」都只是跳到手机控制台**，不在这里直接执行。停止一个正在跑的回合不可逆，
值得让人在能看到上下文的地方点。跳过去时地址会带上 `#stop` / `#compose`，
控制台据此切到会话页并给出提示。

> 技术注记：`ProgressStyle` 和 `BigTextStyle` 都走 `setStyle`，而 `setStyle` 是**覆盖式**的，
> 两者只能留一个。这里留 `ProgressStyle`（进度条），所以文字信息全部走
> title / contentText / subText，不再用 BigTextStyle。

### 怎么从控制台回到应用主页面

WebView 一旦导航到控制台，页面本身是没有出口的——这个坑踩过，用户会被困在里面只能杀进程。
现在两条路都有：

- **系统返回键**：在控制台里按返回 → 回到应用的配对页；再按一次才真的退出。
- **控制台左上角的 ⌂ 按钮**：只在应用内显示（应用打开控制台时会带上 `&mcapp=1` 标记）；
  用普通手机浏览器打开配对地址时不会出现，因为那里没有"应用主页面"可回。

> **第一版为什么没生效**（真机实测：按返回直接回桌面）。原因是 Android 15 起、
> targetSdk 35+ 的应用**预测性返回默认开启**：系统走 `OnBackPressedDispatcher`，
> 直接调用注册进去的回调，**不再经过 Activity 的 `onBackPressed()` 覆盖方法**。
> 我第一版只覆盖了 `onBackPressed()`，于是它根本没被调用，落到默认行为 `finish()`。
>
> 另外确认过：**Capacitor 自己完全不接管返回键**（`BridgeActivity` 与 `Bridge` 里
> 没有任何 `onBackPressed` / `canGoBack`）。所以不存在"谁抢了返回键"，
> 就是我的处理方式用错了 API。
>
> 修法是往 dispatcher 里注册 `OnBackPressedCallback`（保留 `onBackPressed()` 覆盖照顾老系统）。
> 顺带把"当前在控制台"从一个 URL 字符串比对改成了显式标志——字符串比对一旦因为斜杠或
> 端口对不上就会静默失败，表现同样是"返回键和 ⌂ 按钮都没反应"。

### 躲开状态栏与导航栏

targetSdk 35 起 Android **强制** edge-to-edge，应用无法再退出这个模式
（`windowOptOutEdgeToEdgeEnforcement` 在 16 上已失效）。代价是内容默认画到系统栏底下：
顶部标题栏被状态栏压住、底部标签栏被导航栏压住。

做法不是"关掉"，而是**把系统栏占的位置让出来**：

```java
ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
    Insets bars = insets.getInsets(systemBars() | displayCutout());
    Insets ime  = insets.getInsets(ime());
    view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
    return insets;
});
```

- 内边距加在内容视图上，所以 **WebView 的可视区域本身就避开了系统栏**，网页里不需要任何适配；
- **键盘也一并算进去**：edge-to-edge 下 `adjustResize` 不再自动顶起内容，
  不处理 IME inset 的话，给智能体发消息时输入框会被键盘挡住；
- 底部取 `max(导航栏, 键盘)`——键盘弹起时导航栏 inset 通常变 0；
- 状态栏/导航栏图标设为**浅色**（界面是深色的，默认深色图标在深底上几乎看不见）；
- `windowBackground` 从 `@null` 改成 `#11131A`，与网页面板底色一致，
  否则让出来的那一条会和面板颜色对不上。同时给启动主题补上了 `postSplashScreenTheme`——
  少了它应用会一直停在启动图主题上，那个窗口底色也就不会生效。

---

## 权限与取舍

| 权限 | 为什么需要 |
| --- | --- |
| `INTERNET` | 连电脑上的插件 |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` | 常驻连接。**类型选 `specialUse` 而不是 `dataSync`**：Android 15 起 `dataSync` 有每 24 小时 6 小时累计上限，而这里需要长期挂着。 |
| `POST_NOTIFICATIONS` | Android 13+ 发通知必须授权 |
| `ACCESS_NETWORK_STATE` | 判断连接状态 |
| `WAKE_LOCK` | 保证 Service 的 SSE 线程在 Doze 下不被掐断 |

`android:usesCleartextTraffic="true"`：局域网里的插件是纯 HTTP，没有它 WebView 与 Service 都连不上。
这个应用**只适合可信局域网**——和插件本身的安全模型一致。

---

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `MainActivity.java` | Capacitor 的 WebView 外壳；注册插件、申请通知权限、已配对就拉起服务 |
| `PairingPlugin.java` | 暴露给配对页的原生桥：`save` / `load` / `open` / `stop` |
| `Pairing.java` | 配对地址解析与持久化（SharedPreferences）。后台是原生进程，读不到 localStorage |
| `ConsoleService.java` | 前台服务：SSE 长连接、断线重连、通知生命周期（**只有它管通知**） |
| `ConsoleState.java` | 从快照 JSON 里挑出通知需要的部分（状态计数、余额、待办） |
| `Notifications.java` | 两枚通知的构建；API 36 的 Live Updates 就挂在这里 |
| `XiaomiIsland.java` | 小米超级岛 / 焦点通知适配：能力探测 + 岛参数拼装，探测不过就完全不介入 |
| `ApprovalReceiver.java` | 通知按钮的落点：后台线程回一个 POST |
| `ConsoleClient.java` | 极薄的 HTTP 客户端（只用 `HttpURLConnection`，不引三方库） |

### 一个刻意的设计：通知生命周期只有一个主人

「允许 / 拒绝」的按钮**不自己撤通知**，撤通知是 `ConsoleService` 按快照统一做的。
这样万一某次提交失败，待办还在快照里、通知也就还在，用户可以直接再点一次——
而不是看着一条消失了却没生效的通知发愣。

---

## 已知限制

- **没有在真机上跑过。** 本仓库的验证到"能真实构建出可安装的 APK、包内容正确"为止——
  构建环境里没有连接设备，也没有装模拟器镜像，所以**运行期行为（通知是否被系统提升为 Live Update、
  小米岛参数是否被 ROM 接受、按钮是否真的拦住操作）没有实测**。第一次装到手机上时，请重点看这几件事。
- **厂商准入是硬门槛，不是代码问题。** 荣耀灵动胶囊至今没开放原生实时通知 API；小米超级岛虽然有
  客户端实现路径，但 FAQ 明确要求先发邮件申请焦点通知权限并由平台配置；华为实况窗要「服务权益」；
  vivo 原子通知要开放平台开通。**本应用能开箱可用的是 Android 16 标准通道**（OPPO 明确走这条）。
  其余的都是探测到权限/能力就自动启用、探测不到就安静降级。
- **小米岛的参数是"尽力而为"的**：字段依据官方《开发指南》正文，但大岛 / 小岛的具体模板字段在
  一份单独的 PDF 模板库里，随 ROM 版本变化。所以可能出现"岛不显示"或"岛显示得不够好看"。
  这不会影响普通通知——那条通知的其它字段完全没动。
- **标准通道还依赖用户侧开关**：Android 16 的「实时更新」权限是应用级用户设置，清单里没有对应权限
  可声明。没开时通知照常发出（信息不少），只是不会上岛；应用会在通知上挂一个一键跳过去开启的动作。
- 只在局域网内可用。手机离开同一个 Wi-Fi 就收不到更新（这是插件的安全模型决定的，不是缺陷）。
- Live Updates 的"提升"由系统决定：即使权限开了、调用正确，系统也可能因为电量策略、通知频率等原因
  不提升，这时它就是一条普通常驻通知。
- 待审批目前每条一个通知；同一时刻大量审批会刷出多条。

---

## 创作说明

本文档与应用代码由 **DeepSeek V4.1 Flash** 创作，由 **DeepSeek Harness** 驱动完成。
