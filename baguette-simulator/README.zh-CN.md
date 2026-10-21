# iOS 模拟器

需要 macOS 15.0 或更新版本；旧系统会在启动随包二进制之前明确返回 UNSUPPORTED_OS。

[English](README.md)

Cindy 官方 iOS 模拟器，适用于 Apple Silicon Mac，随包带 Baguette 0.2.10。它替代已下线的内置模拟器；原内置模拟器用户会在 Cindy 中看到一次指向这里的迁移提示（插件 ID 为 `baguette-simulator`）。需要 Cindy 0.1.83+、完整 Xcode 和已安装的 iOS runtime，首次运行不下载依赖。打包时通过 binary-dependencies.json 从固定哈希的官方归档收集九个可移植 USDZ 模型；原生可执行文件仍保留在 Git，仅支持 macOS。

iOS 模拟器任务默认使用。先 environment、devices，复用适合的已登录设备，必要时 boot。App 仍由项目正常 Xcode 流程构建，再用 install_app、launch_app 安装和启动模拟器 .app。launch_app 默认打开当前任务的模拟器页签；检查 viewer.previewOpened，不能把服务启动成功说成页面已显示。切换 session 后通过 open_viewer 打开已有设备。

两个界面：每个任务在右侧栏有自己的「iOS 模拟器」页签（只有画面和控制条，没有地址栏）；左侧导航的「模拟器」不跟对话，参考 Xcode Device Hub 做成左右分栏：左侧按「运行中」「已关闭」分组列出全部设备（超过六台显示搜索），每行显示机型、iOS 版本，以及空闲还是被任务在用；右侧显示选中设备的实时画面。**+** 可新建 iPhone 或 iPad，表单含名称、系统版本和机型（机型按所选系统版本筛选，名称在手动修改前跟随机型）。每行的 ⋯ 菜单或右键菜单提供启动 / 关闭、在当前任务中打开（仅当前面有任务且该任务还没在用这台设备时出现，伙伴对话也算）、改名、抹掉所有内容和设置…、删除…（后两项需确认；运行中的设备会先关机，删除同时清除它的任务绑定）。任务用哪台设备由 AI 打开模拟器时决定：devices 每行带 tasks、thisTask，可复用空闲设备或新建；boot、open_viewer、launch_app 把设备绑定到调用所属的任务（`~/Library/Application Support/BaguetteCindy/task-bindings.json`，权限 0600）。还没有设备或设备已关闭时，页签显示设备列表或「启动」，不留空白。宿主不支持任务页时回退到侧栏预览。

控制页由 Cindy 自己绘制：设备胶囊（状态圆点、设备名，点开可切换、添加、改名）、缩放控件（−、百分比菜单含适合窗口 / 实际大小 / 固定档位、+）和「更多」菜单（摇一摇、App 切换器、解除卡键、恢复画面、Baguette 高级工具、需确认的关闭设备）。主屏幕、截图、向左 / 向右旋转，以及折叠屏的合上 / 半展开 / 展开姿态浮在画面下方。快捷键与 Simulator 一致：⌘+ / ⌘− / ⌘0（适合窗口）/ ⌘1（实际大小）、Ctrl 滚轮缩放、⌘← / ⌘→ 旋转、⇧⌘H 主屏幕、⌘S 截图。缩放和方向按设备记住；缩放保持中心，超出窗口时可滚动。控制页截图存到桌面，提示里可「在访达中显示」。内嵌的 Baguette 页面带边框渲染设备（`?handheld=0`；折叠屏保留 3D 视图），其工作台界面由注入样式隐藏。画面断开、闲置倒计时和设备已关闭都直接显示在画面位置，并提供恢复 / 继续使用 / 启动按钮；没有明确操作不会重启模拟器或 App。Agent 使用 press(button=release-input) 解除卡键。Unicode 粘贴会替换模拟器剪贴板；网页复制会替换 Mac 剪贴板。输入前观察焦点，之后核对结果；按键投递回调不代表 App 处理完成。

设备保存于 ~/Library/Application Support/BaguetteCindy/devices，Agent 截图在同级 screenshots。不会操作默认或 Cindy 内置设备；只有通过上面需确认的菜单项才会抹掉或删除设备。同 bundle ID 覆盖安装通常保留 App 数据，但登录态仍由 App 数据迁移、退出登录和服务端有效期决定。并发 Agent 不要交错操作同一设备。

heal 会重启 SpringBoard 并关闭 App，必须先让用户接受影响；卡键先尝试按键释放。shutdown 关闭设备但保留数据，close_viewer 只停止画面服务。

## 自己控制设备

打开 **插件 → iOS 模拟器**，可查看独立设备的实际状态、启动或关闭设备、打开画面、添加设备，以及全部关闭。关闭 **允许运行模拟器** 时先保存禁止启动状态，再关闭设备和画面服务；关机失败会明确显示，开关关闭期间工具不能重新启动设备。重新打开开关不会自动开机。设备数据和登录信息保留。

关闭设备（需确认）在「更多」菜单里；画面默认适应窗口。App 内双指缩放仍使用 Option 拖动或 Ctrl 滚轮，与画面大小分开。默认闲置 15 分钟关闭，可改为 30 分钟、1 小时或仅手动。画面窗口开着、或有其他工具或脚本在自己的命令行里点名这台设备（如 `simctl`、`xcodebuild -destination id=…`、Baguette 命令行）时不会因闲置关闭；设备输入和工具操作会重新计时，状态轮询不会。只要有设备或画面窗口开着，Cindy 就会保持插件工作进程运行。关机终止 App 和连接。全部独立设备共用闲置计时；修改闲置设置会重新计时。

设备胶囊菜单提供 **切换**、**添加设备** 和 **重命名**。添加时默认选中最新 iPhone 和它最新的已安装 iOS 版本（可改）；新设备保持关闭，切换到它才会启动。没有设备时，插件设置页提供一键 **创建第一台 iPhone**。改名保留 App 和数据；换机型或系统版本会新建独立设备，保留原设备。切换会先确认旧设备已关闭，再启动目标设备，并在同一预览显示进度；若还有其它运行中的独立设备，需先关闭。

插件在 `runtime-settings.json.apps.json` 记录各设备最近一次由插件成功启动的 App。从运行中的设备切换时，可把该 App 的模拟器应用包安装到目标设备并打开；系统 App 按标识符打开。不复制 App 数据、登录信息或凭证。没有记录时显示目标设备主屏；原设备已经关闭时，目标设备需已安装记录中的 App。不兼容或启动失败会显示实际设备状态，不保证两台设备有相同内容和登录态。

运行偏好保存在独立设备目录旁的 `runtime-settings.json`，本机使用该设备集合的入口共享。Worker 正常退出时尝试关机，但被强制终止可能来不及完成。在 Cindy 中停用插件 **之前**，先用设置页的运行开关关闭设备，并检查显示状态。预览关闭或断线不证明设备已经关闭。

## 安全与限制

Node Worker 有当前用户级本机权限。只调用固定可执行文件和命令形状，不提供任意 Shell 工具。控制页仅监听 127.0.0.1；剪贴板与控制请求校验来源、随机能力令牌和已打开的独立设备。能力令牌与画面端口一起保存在 `~/Library/Application Support/BaguetteCindy/viewer-session.json`（权限 0600），工作进程重启后已打开的页签可以自动接上；关闭运行开关时作废。不会提取账户令牌或转存到 Cindy。截图分析可能把画面送给模型；App 内操作可能造成外部业务副作用，仍须遵守任务授权。

画面的可选 OpenStreetMap 地图请求通过固定端点的 Node 代理发送；farm 页面使用本机字体回退，不请求远程字体。详见 VENDOR-REVIEW.md；这些功能不涉及同步模拟器账户。不会后台安装依赖。

上游 0.2.7 新增 App 偏好设置（UserDefaults）编辑卡片，可读取或改写任意已安装 App 的设置，并以注入 dylib 的方式重启 App。这些接口不使用独立设备目录，因此插件隐藏该卡片、在画面代理对相关接口返回 404，且不打包 `DefaultsLookups.dylib`。Handheld 模式为上游原有行为，仍只监听本机。

已知限制：iOS 27 上断开视频连接可能触发上游 SIGABRT。服务每分钟最多自动重启五次，独立控制页可手动恢复；这是缓解，不是原生崩溃根治。插件停用或 Cindy 退出时控制页也会停止，需要 Cindy 再次启动。设备数据跨任务保留，每个任务页签记住自己的设备。

## 构建与验证

原生 release 构建使用全程序 LTO 和 Swift -Osize、移除符号并临时签名，确保 Git 中二进制总量符合仓库限制。

在装有 Xcode 的 Apple Silicon Mac 上运行 sh native/build.sh，编译随包 Objective-C 源码并临时签名，不下载依赖；Baguette 和 HingeControl 基于 v0.2.10 重新编译，vendor-native.patch 只改版本号；运行 sh native/build-baguette.sh <已验证的源码压缩包> 可重建，之后运行 node native/inventory.mjs --write。本插件需要的独立设备目录与 3D 内存两处修复已合入上游（tddworks/baguette#122、#123）。运行 node .tests/baguette/real-simulator-smoke.mjs --foldable 可在临时设备目录中用真模拟器检查一次构建。

运行仓库契约和 .tests/baguette-simulator.test.mjs。审核 VENDOR-REVIEW.md、THIRD-PARTY-LICENSES.txt 和提案 #119：https://github.com/makecindy/cindy-official-plugins/issues/119。首发为空定向受众，不推送全体用户。最终包在合格 Cindy 客户端内的安装验证，必须与直接 Node/原生测试分开记录。

可选位置面板通过 Node Worker 向 OpenStreetMap 发送搜索词和地图瓦片请求，仅使用固定 HTTPS 端点 nominatim.openstreetmap.org 与 tile.openstreetmap.org。浏览器请求保持同源；拒绝重定向和任意上游 URL，不转发账号凭证。

画面代理的 HTTP 和 WebSocket 均要求令牌会话；控制页用片段中的令牌换取 HttpOnly 会话 Cookie。这不构成对同一 macOS 用户权限进程或直接访问上游 Baguette 监听端口的沙箱隔离。

## iPhone Duo 与 Xcode 兼容

普通设备保留 Xcode 26/27 路径。iPhone Duo 需要当前选用 Xcode 27.1，并已安装 iOS 27.1 runtime。上游预览页提供 Duo 3D 模型、内外屏、姿态按钮和折叠角度滑杆；切换姿态会改变模拟设备状态及前台 App 布局。模型直接读取 Xcode，不由插件下载。插件使用当前选定的 Xcode，不自动安装、切换或降级 Xcode。剪贴板写入优先使用 CoreDevice，旧环境或不支持时回退到独立设备集合的 simctl。

已在 Cindy 0.1.93 Beta / iOS 27.1 实测 Duo 预览、合拢/展开、触控和中文输入。Xcode 26 集成尚未复测，具体边界见 VERIFICATION.json。

## 上游与许可

本插件基于 tddworks 的开源项目 [Baguette](https://github.com/tddworks/baguette)（Apache-2.0）。Cindy 维护插件集成、Node Worker 以及 VENDOR-REVIEW.md 记录的本地补丁（`vendor-native.patch`、`vendor-web.patch`），与 tddworks 无隶属或背书关系。随包 HingeControl 含改编自 Meta idb 的代码（MIT）。完整许可证见 THIRD-PARTY-LICENSES.txt 与 `HingeControl/LICENSE.idb`；图标为 Cindy 自有的 iOS 模拟器图标。

设置无法读取时，仍可查看状态和关闭设备，但禁止启动和修改设置；恢复设置文件后才能恢复运行许可。切换设备自动安装源应用包时，可能替换目标上相同 bundleId 的已有 App；不会复制源 App 数据或登录凭证。
