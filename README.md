# harness-pocket

在手机上远程用 DSH：**看智能体状态、批审批、发消息、回答问题**，
状态会以 Android 16 原生「实时更新」的形式出现在状态栏与各家灵动岛上。

由两部分组成：

- **`plugin/`** —— 电脑端的 DSH 插件，在局域网里起一个小服务，手机连它；
- **`android/`** —— 手机端 Android 应用（Capacitor + 原生 Java），负责后台常驻、通知与上岛。

## ⚠️ 先读这一段

**这个工具能让你在手机上批准 AI 的工具调用——等同于远程批准在自己电脑上执行命令。**

- 插件监听在局域网上，靠一个**配对令牌**鉴权。**令牌等同于你电脑的命令执行权限，别外传、别截图。**
- **不要把服务暴露到公网**（不要做端口转发、不要放到反向代理后面）。它设计成只在可信局域网内使用。
- 审批按钮是**真的批准**：需要越权的操作会真的执行。「拒绝」会拦下。
- 出了事没有审计日志能救你。请只在你自己可控的网络和设备上用。

细节见 [plugin/README.md](plugin/README.md) 的安全模型一节。

## 目录

```
harness-pocket/
├── plugin/        电脑端：DSH 插件
├── android/       手机端：Android 应用
└── dist/          图标预览等静态产物
```

两个子项目各有自己的 README，细节都在里面：

- [plugin/README.md](plugin/README.md) —— 插件能力、安全模型、测试、与 DSH 的接线方式
- [android/README.md](android/README.md) —— 通知怎么上岛、厂商适配、诊断与日志、构建步骤

> 仓库里**不含构建工具链**（Android SDK + Gradle 缓存约 1.8 GB）也**不含 APK**。
> 构建步骤见 [android/README.md](android/README.md#构建命令)。

## 安装

装法分三步：**电脑装插件 → 手机装应用 → 两边配对**。全程大约五分钟。

### 前置条件

| 需要 | 说明 |
| --- | --- |
| 电脑装了 DSH | 插件跑在 DSH 进程里 |
| 手机与电脑**同一个 Wi-Fi** | 插件监听在局域网，不走公网 |
| Android 13 及以上 | 通知需要运行时权限 |
| **Android 16 及以上** | **只有这个版本才有原生「实时更新」/ 灵动岛**；低版本能用，但通知是普通常驻样式 |

### 第一步：电脑端装插件

```bash
dsh plugin --profile desktop add https://github.com/flux9527/harness-pocket/tree/main/plugin
```

装完**重启 DSH**（或等它热重载）。这一步的作用是把包加进 profile 的 `dependencies`
和 `dsh.profile.bundles`——**只有装成包，DSH 设置页里才会出现「手机控制台」那一节**，
因为浏览器半边是按包名加载的。

不想装成包、只要手机网页能用的话，也可以直接在 profile 的 `cordis.patch.yml` 里挂
`boot.js` 的绝对路径（更快，但没有设置页入口）。三种方式的区别见
[plugin/README.md 的「安装」一节](plugin/README.md#安装)。

Windows 第一次监听时可能弹防火墙提示，选**专用网络**。没弹或误点了取消：

```powershell
New-NetFirewallRule -DisplayName "DSH Mobile Console" -Direction Inbound `
  -Protocol TCP -LocalPort 8799 -Action Allow -Profile Private
```

（默认端口 8799；被占用时插件会自动往后顺延最多 10 次，实际端口看 `/mobile status`。）

验证一下装好了没：

```
/mobile status
```

### 第二步：手机端装应用

**方式一：直接从 Releases 下载**（最省事）

到本仓库的 **Releases** 页面下载最新的 `.apk`，传到手机点击安装即可。
它是**正式签名**的包，可以直接覆盖升级。

**方式二：自己构建**

仓库里**不含 APK**（二进制不适合进 git）：

```bash
# 详细前置与排错见 android/README.md#构建命令
cd android
pnpm install
npx cap copy android
cd android

./gradlew.bat assembleDebug     # 调试包，自己测试用
# 或
./gradlew.bat assembleRelease   # 正式包，发布给别人用（需要先配好签名，见 android/README.md#发布打正式包）
```

调试包产物在 `android/android/app/build/outputs/apk/debug/app-debug.apk`。
把它传到手机（数据线 / 微信文件传输 / 网盘都行），点击安装——
手机会要你允许「安装未知来源应用」。

> ⚠️ **别把调试包发出去。** 它带着 `android:debuggable="true"`、
> 用口令公开的调试密钥库签名、并且允许备份——而本应用存着配对口令。
> 原因与正式签名做法见 [android/README.md 的「发布与签名」](android/README.md#发布与签名)。
>
> 调试包与正式包**签名不同，不能互相覆盖安装**，切换时要先卸载。

打开应用后：

1. **必须允许通知权限**——否则通知和审批按钮都不存在；
2. 首次打开是配对页，先别急着填，去做第三步。

### 第三步：两边配对

1. 在电脑上的 DSH 里，对**你想用手机接管的那个会话**执行：

   ```
   /mobile on
   ```

   > 这一步是「武装」当前会话。**没武装的会话，行为和不装插件时完全一样**，
   > 审批不会转到手机。想接管多个会话就分别执行。

2. 拿到配对地址：

   ```
   /mobile url
   ```

   会输出形如 `http://192.168.1.5:8799/?k=<32位令牌>` 的地址。
   **整段复制**——令牌就在里面，只复制到端口是连不上的。

3. 把地址粘进手机的配对框，点「配对并启动后台服务」。
   状态栏会出现一条常驻通知。

4. **Android 16 上再开一个开关**：应用的 **诊断** 页会检测系统的「实时更新」开关，
   没开的话页面底部有个按钮，一点就跳到系统那一页。
   不打开的话通知照常显示，但**不会被提升成灵动岛**。

### 装好之后

用应用里的 **诊断** 页确认整条链路：它会逐条检查配对信息、通知权限、实时更新开关、
厂商通道、后台服务、能不能连上电脑，并给出**一句结论**。任何一环不对都能直接看出来。

然后按需验证：

- 状态栏/灵动岛：左边图标随状态变（▶ 运行 / ❗ 审批 / ○ 空闲 / ⊘ 断联），右边是状态文字，
  展开能看到余额、进度条和操作按钮；
- 审批：让 AI 跑一个需要授权的操作，手机上点「允许 / 拒绝」——**这是真的批准**，
  点「允许」等同于在电脑上同意；
- 发消息 / 停止：通知上的按钮会跳到控制台对应的位置。

排错看 [plugin/README.md 的「排错」一节](plugin/README.md#排错)，
以及 [android/README.md 的「应用内诊断与日志」](android/README.md#应用内诊断与日志)。

## 已知限制

- **Android 侧没有在真机上自动化测试过**——开发时没有 adb 设备也没有模拟器镜像。
  验证方式是构建期检查 + APK 内容核对 + 图标几何渲染；真机表现靠应用自带的诊断页与日志页反馈。
- **厂商灵动岛是审批制的**：小米要注册开发者、上架应用、配置指纹证书并过场景预审；
  荣耀尚未开放原生实时通知接口；华为实况窗、vivo 原子通知各有权益申请。
  **标准 Android 16 实时更新不需要任何审批。**
- 发布产物用的是**自签名证书**（不是 Play 商店签名），首次安装需要允许「安装未知来源应用」，
  且换签名后必须卸载重装。

## 许可证

[MIT](LICENSE) © 2026 harness-pocket contributors

> `LICENSE` 里的版权主体目前写的是 `harness-pocket contributors`。
> 你发布自己的版本时，可以换成你的名字或组织名。

### 关于参考实现

本项目的 Android 通知实现参考了以下项目的**公开 API 用法**（未复制其代码）：

- [rikkahub](https://github.com/rikkahub/rikkahub) —— **AGPL-3.0**
- [InstallerX-Revived](https://github.com/wxxsfxyzm/InstallerX-Revived) —— **GPL-3.0**

两者都是强 copyleft。目前本项目**不含**它们的任何源码，因此可以自由选择许可证；
但**如果日后从中复制代码，将导致整个项目必须按 GPL-3.0 / AGPL-3.0 开源**。

---

## 创作说明

本项目由 **DeepSeek Harness** 驱动，代码与文档由 **DeepSeek V4.1 Flash** 创作。
