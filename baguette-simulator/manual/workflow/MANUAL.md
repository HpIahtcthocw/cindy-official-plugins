# iOS 模拟器：完整工作流

本插件在独立设备集合里运行 iOS 模拟器：设备只属于本插件，不碰 Xcode 默认设备，也不碰 Cindy 内置设备。所有观察与操作都走模拟器自身的通道（截图、无障碍树、系统触摸），不依赖任何窗口，Mac 锁屏时也能用。画面实时显示在当前任务的侧栏页签，用户可以随时看着你操作或亲自接管。

## 1. 开始

1. `devices`：每行带 `tasks`（几个任务在用）与 `thisTask`。优先用 `thisTask` 为 true 的设备，其次 `tasks` 为 0 的空闲设备；需要干净环境、特定机型或与其他任务隔离时才 `device action=create`（每台约 7–12 GB），新建前用 `environment` 查可用的运行时与机型。
2. `device action=boot`（想马上看画面就加 `screenshot: true`，启动后等画面稳定并附上截图，省一步），然后 `viewer action=open`（或 `app action=launch`，它会顺带打开画面，同样可加 `screenshot: true`）。检查 `previewOpened`，为 true 才能说画面已显示。

不要另外下载 AXe、idb、Maestro，也不要用电脑操控工具去点 Xcode / Device Hub / Simulator 窗口：本插件已经提供真实触摸、截图和等待，后者会抢用户鼠标、在锁屏时失效。

## 2. 构建与安装

本插件不构建项目。构建用项目自己的流程；独立设备不在 Xcode 的设备列表里，所以不要用 `-destination id=<UDID>`，而是构建通用模拟器产物：

```
xcodebuild -scheme <Scheme> -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build build
# 产物：build/Build/Products/Debug-iphonesimulator/<App>.app
```

CMake、Unity、游戏引擎等用项目已有的脚本，找到输出的模拟器 `.app`。

- `app action=install appPath=<绝对路径>`：与已装内容完全相同时直接跳过（`mode: unchanged`）；只改了少量文件时增量同步（`mode: sync`，保留 App 数据）；否则整包安装（`mode: full`）。超过约 80 秒会返回 `state: running` 与 `job`，用 `app action=install_status job=<job>` 继续等，不要重复发起安装。
- `app action=info appPath=<同一路径>`：`matchesLocal: true` 才说明设备上装的就是这次构建。版本号相同不代表是同一次构建，以可执行文件指纹为准。测试前、向用户报告“已修复”前都应确认。
- `app action=launch`：默认先结束旧进程再启动；需要启动参数或环境变量时传 `arguments`、`env`。

## 3. 坐标：一律用视图点

- `screenshot`、`tap`/`gesture` 的 `observe=screenshot`、`screenshot: true` 以及没等到的 `wait_for` 都会把截图直接附在结果里（旧版 Cindy 只给 `path`，用读图工具打开）。
- 截图已按用户看到的方向摆正（横屏、折叠屏内屏都一样），默认 1 像素 = 1 视图点。图上读到的坐标就是 `tap`、`gesture` 要的坐标，不要自己旋转图片、不要换算像素。
- `scale=2` 或 `3` 的截图更清晰，坐标要除以 scale；`region` 截取的局部图，坐标要加上 region 的起点。
- `describe_ui` 的 `frame` 与 `center` 也是视图点，`center` 可直接点击。
- 改方向或折叠姿态后，屏幕尺寸会变；以 `set_state` 返回的 `screen` 或新截图为准。
- 按坐标点击时，如果屏幕在你上次看图之后转了向（用户在画面页旋转、App 自己转屏），会返回 `SCREEN_CHANGED` 而不会点到别处：重新截图后再选点。

## 4. 观察与操作循环

1. 有无障碍树的界面（原生 App、多数 SwiftUI/UIKit/RN 页面）：先 `describe_ui`（可加 `query`），再 `tap text=…` 或 `tap id=…`。同名元素多时加 `role`（如 `field`、`button`）或 `nth`。按文字点击会自动避开屏幕外的同名元素。
2. 没有无障碍树的界面（游戏、引擎自绘、部分 WebGL）：`describe_ui` 自动改为识别画面上的文字（`source: "ocr"`），每行文字带 `frame` 与 `center`；`tap text=…`、`wait_for text=…` 同样按识别出的文字工作，一行里的某个词也能单独定位。没有文字的图标、角色和道具用 `screenshot grid=true` 读坐标后 `tap x=… y=…`；小按钮先用 `region` 放大核对；按坐标点到识别出的文字上时，结果里的 `hint` 会提醒（图标可能被旁边的文字盖住，点中的是文字所属的控件）。识别在本机完成，不上传画面。
3. 操作会带来新页面或弹窗时，用 `until=<新页面上的文字>`（`tap`、`gesture`、`type_text` 都支持）：文字一出现就返回，最长 15 秒，没出现会附上当时截图。比猜 `settle` 更快更准，也省一次截图。
   每次操作后核对结果：`tap` 与 `gesture` 默认在约 0.6 秒后返回新的界面元素（`observe=ui`；游戏里是识别出的文字）；要看画面就用 `observe=screenshot`，截图直接附在结果里，不必再单独截图。动画较长时加 `settle`，或改用 `wait_for`。
4. 输入文字：先点输入框确认焦点，再 `type_text text=…`。默认 `method=auto`：普通 App 里粘贴（精确，支持中文与任意 Unicode）；游戏等没有无障碍元素的界面往往不接受粘贴，改为逐键输入英文、数字与符号，设备键盘是拼音、日文等输入法时会自动切到英文（结果里会说明，Ctrl+空格切回）。粘贴后输入框仍为空就用 `method=type` 重试；游戏里要输入中文只能粘贴，不接受时如实告诉用户。提交用 `keys: ["Enter"]`，清空用 `clear=true`。按键可写 `Enter`、`esc`、`up`、`a`、`A`、`cmd+A`、`shift+Tab`。
   - 粘贴（Cmd+V）、逐键输入、`keys`、`clear` 都是硬件按键：iOS 会当作接了硬件键盘，本次开机内点输入框都不再弹出屏幕键盘（插件会在之后清掉这个记录，设备重启后恢复）。要检查“键盘弹出时按钮是否被挡住”，在开机后、发任何按键之前：点输入框看键盘，再用 `method=touch`（点编辑菜单里的「粘贴」，纯触摸，键盘保持弹出）填入文字后截图。`method=touch` 用在已聚焦的空输入框上。
   - 逐键输入时屏幕键盘不会出现，所以不能靠“键盘有没有收起”判断编辑状态；输入框可能自动大写或纠错，和真机接键盘一样。只想结束编辑就点输入框以外的空白处；游戏里 `Enter` 常常等于确认，会直接提交或翻页。
5. 长列表找目标：`gesture kind=scroll_to text=…`，到底仍没有会报告并列出当时可见的文字，可据此修正文字（例如 iOS 27 的“隐私与安全”没有“性”字）。

## 5. 等待，而不是 sleep

- 等某个元素出现：`wait_for text=… timeout=…`；等它消失：加 `gone=true`。
- 等加载或动画结束：`wait_for stable=1`（画面变化低于 `tolerance`，默认 0.5% 像素，持续 1 秒）。游戏启动、场景切换用 `stable=2` 和较长的 `timeout`。
- 游戏背景常有持续动画（水面、粒子、待机动作），画面永远不会完全静止：没等到时会返回 `met: false`、每帧典型变化比例、建议的 `tolerance` 和当时截图；按建议加大 `tolerance`，或用 `region` 只看 UI 所在的区域。
- 等 App 打出某条日志：`wait_for log=<正则> bundleId=…`。
- 没等到时返回 `met: false`（不是报错），附原因、当时屏幕上的文字与截图，据此判断是没加载完、走错页面还是出错了，不要盲目加长时间重试。
- `device action=boot`、`app action=launch` 的 `screenshot: true` 会先等过黑屏启动帧和加载动画再截图；画面仍是黑屏时截图说明里会提示。

## 6. 抓一闪而过的画面

转场、按钮高亮、Toast、骨架屏、首帧闪烁这类内容，用 `capture`：

```
capture action={"tool":"tap","args":{"text":"登录"}} seconds=2 fps=12
```

返回一张按时间排列、标注毫秒的联系表（负数是动作之前），以及各帧文件。动作可以是 `tap`、`gesture`、`press`、`type_text`、`open_url`、`app_launch`。录制只在画面变化时出帧，静止画面只有一两帧是正常的。

## 7. 设备状态

一次 `set_state` 可改多项：

- `orientation`：`portrait`、`landscape-left`、`landscape-right`、`portrait-upside-down`。App 不支持某方向时界面不会转，以截图为准。
- `posture`（iPhone Duo 等折叠屏）：`closed` 用外屏，`open`（130°）与 `flat`（180°）用内屏；也可传 0–180 的角度。
- `appearance`、`contrast`、`text_size`：深色模式、增强对比度、动态字体。
- `network`：`lte`、`3g`、`edge`、`very-bad-network`、`100-loss`、`offline` 或 `{latency, bandwidth, loss}`；只对之后启动的 App 生效，改完用 `app action=launch` 重启 App；结束时 `network: "clear"`。
- `location`：`{lat, lon}` 或 `clear`。
- `status_bar: "clean"`：9:41、满格满电，适合出商店图与对比截图；`clear` 还原。
- `privacy`：`{action: "grant", service: "photos", bundleId: …}` 等，提前授权以免权限弹窗挡住流程。改权限会结束该 App，请在启动前设置。

## 8. 日志与崩溃

- `logs bundleId=… level=error`：最近的错误与故障；`match` 用正则过滤；`last_seconds` 控制时间窗。
- 默认附带本设备上该进程最近的崩溃摘要：异常类型、原因、崩溃线程调用栈。App 闪退、白屏、卡在启动页时先看这里。

## 9. 系统弹窗

“是否打开某 App”、权限请求、通知授权这类系统弹窗不一定在 `describe_ui` 里出现：先截图，按图上坐标点击按钮。能提前避免的（权限）用 `set_state privacy` 预先授权。

## 10. 验证原则

- 验证交互必须用 `tap` / `gesture` 的真实触摸。不要往 App 进程注入事件（lldb 调函数、注入 dylib 发消息、改 SDL/Unity 输入队列），这会绕过系统触摸链路，出现模拟器里“测过”、真机上点不动的假通过。
- 汇报前确认装的是这次构建（`app action=info` 的 `matchesLocal`）。
- 只说实际看到的结果：截图或 `describe_ui` 里看到了才算；工具回执“已发送”不等于界面有反应。
- 用户说自己来测时，不必把每个细节都自动化验证一遍。

## 11. 异常恢复

- `BUSY`：同一台设备上的上一个操作还没结束（安装、录制等），等它完成。不同设备之间互不阻塞。
- 键盘连发或卡键：`press button=release-input`。
- iOS 27 上所有触摸都“成功”却没反应：多半是 Xcode Device Hub 抢占了输入，先告知用户，经同意后 `heal`（会重启 SpringBoard、结束运行中的 App）。
- `SCREEN_UNAVAILABLE`：App 正在启动或切换，稍等后 `wait_for stable=1` 再试。
- `SCREEN_CHANGED`：屏幕方向或折叠面板在你看图之后变了，什么都没发送；重新截图再操作。
- `RUNTIME_DISABLED`：用户在插件设置里暂停了模拟器，不要替用户打开，告诉用户去哪里开。

## 12. 画面页与收尾

`viewer` 打开的画面页由用户操作，可以输入、旋转、摇一摇、截图（存桌面或剪贴板）、切换与启停设备，以及使用 Baguette 高级工具（位置与运动模拟、状态栏与网络条件、摄像头输入、无障碍树、日志、录屏导出，可能包含 App 隐私数据；地图搜索与瓦片经插件代理发往 OpenStreetMap）。打开前把这些告诉用户；打开页面不会自动执行它们。

用完：不再需要的设备 `device action=shutdown`；`network`、`status_bar`、`location` 改过的记得还原。删除或抹掉设备只在用户要求时做。
