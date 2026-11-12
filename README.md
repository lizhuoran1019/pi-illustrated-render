# pi-illustrated-render

**在同一条 Pi 回答里阅读文字、示意图、公式和中文表格。** 图片跟着相关段落出现，不必跳到工具结果或浏览器。

基于 [pi-better-render 0.5.0](https://github.com/JeffeyChou/pi-better-render) 的独立派生插件：保留公式与 Markdown 排版，新增本地 SVG/PNG 插图渲染、图片缓存、引用式图片复制和恢复处理。

## 先试用，不改现有配置

要求：**Pi 1.5.2、Node.js 22.19+、Kitty 图像协议终端**。已在 Linux / Kitty 0.50.0 中实测；其他终端未做实机验证。不支持图像时显示说明和文件路径。

克隆仓库、安装依赖，然后开启临时会话：

```fish
git clone https://github.com/lizhuoran1019/pi-illustrated-render.git
cd pi-illustrated-render
npm ci
pi --no-extensions -e ./src/index.ts
```

这只在新会话中加载本插件，临时跳过其他扩展。你可以直接问：

> 重新解释场强、电势和电势能，把示意图穿插在对应段落之间。

插件会向模型提供插图写法。模型仍需要先用文件工具画好示意图；旧回答里的纯文字不会凭空变成图片。

### 不调用模型的演示

```fish
pi --no-session --no-tools --no-extensions -e ./src/index.ts -e ./tools/visual-fixture.ts
```

进入 Pi 后输入 `/visual-fixture`。这会用真实的助手组件展示 `examples/physics.md`，包含两幅 SVG、一个 PNG、公式和表格，无需 API 调用。此演示扩展仅用于验证，不要加入日常扩展列表。

## 正式启用

**本插件与 pi-better-render 二选一。** 两者都会接管助手 Markdown 组件，不能同时加载；发现冲突时本插件会提示并停止接管。

1. 在终端运行 `pi config`，取消启用 **pi-better-render 的 extension**，其余扩展保持原样。
2. 从 GitHub 安装，Pi 会自动安装运行依赖：

   ```fish
   pi install git:github.com/lizhuoran1019/pi-illustrated-render
   ```

3. 回到 Pi 输入 `/reload`，然后用 `/illustrated-render status` 查看状态。

要切回旧版，在 `pi config` 中禁用本插件、重新启用 pi-better-render，再 `/reload`。无需删除任一插件的源码。

## 图片放在自己的段落里

```markdown
场强决定电荷所受的电场力。

![正负电荷在同一电场中受力相反](/完整路径/.pi/diagrams/field.svg)

势能还取决于电荷的正负号：

$$E_p=q\varphi$$
```

- 支持本地 **SVG、PNG**，绝对路径、`file://` 和相对路径。相对路径以 **Pi 会话工作目录**为基准，不是 Markdown 文件所在目录。
- 图片前后各留一个空行；图片说明会显示在图下。普通的引用式写法 `![图][id]` 也支持。
- 与文字挤在同一段的图片保留文字占位，不展开成大图。代码块里的图片语法不会触发读取。
- 建议把图保存在项目的 `.pi/diagrams/` 等持久目录，不用 `/tmp`，恢复旧会话时才能继续显示。
- SVG 使用自包含矢量图、较大的标签和高对比背景；中文字体取自系统。推荐 Noto Sans CJK。
- 保持长宽比，默认最多占 100 列、28 行；图题与图片左边缘对齐，并按图片宽度换行。内容密集的图应拆开，而不是缩小文字。
- 图下的 **查看原图** 是本地文件链接，使用终端的打开链接手势即可在外部查看器查看或放大。在 Kitty 默认配置中，按住 `Ctrl+Shift` 并点击链接。插件不会自动启动外部程序。

### 透明图看不清，或长图太小？

黑色线条的透明 SVG 在深色终端里可能看不见。加一个浅色底板即可，不会反转颜色或改动图片文件：

```text
/illustrated-render images:bg:light
```

白色线条可用 `images:bg:dark`。`images:bg:none` 恢复原来的透明背景，也是默认设置；带不透明背景的图片仍使用自身的颜色。

长图默认只展示紧凑预览。想在正文中看大一些，可以增加预览高度：

```text
/illustrated-render images:height:56
```

高度可设为 **8–120 行**，`images:height:28` 恢复默认。图片仍受窗口宽度和栅格尺寸限制；检查密集标签时，优先使用 **查看原图**。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `/illustrated-render status` | 查看状态和图像通道 |
| `/illustrated-render off` / `on` | 在原生 Markdown 与图文排版之间切换 |
| `/illustrated-render images:off` / `images:on` | 单独关闭或开启插图 |
| `/illustrated-render images:bg:light` / `dark` / `none` | 为透明图选择浅色、深色或透明底板 |
| `/illustrated-render images:height:56` | 调整预览最大高度，范围 8–120 行 |
| `/illustrated-render refresh` | 文件改好后重新读取图片、刷新排版 |
| `/illustrated-render clear-cache` | 清理缓存和本插件的终端图片，再重绘当前内容 |
| `/illustrated-render math:streaming` | 在输出过程中渲染公式，默认模式 |
| `/illustrated-render math:final` | 回答完成后再渲染公式 |
| `/illustrated-render math:off` | 关闭公式图片，保留文本形式 |

`lines` 切换代码行号；`mermaid` 切换继承的字符图渲染，默认关闭。这些命令不写入用户配置；重新加载扩展后恢复默认值。

行内公式会整体换行，不把同一张公式图切到两行。公式超过整行宽度、且无法保持可读字号时，会退回文本形式。复杂分式、积分或较长的等式，建议单独使用 `$$ … $$` 公式块。

## 文件、复制与限制

- 只读取普通本地文件，单图不超过 **8 MiB、1600 万像素**。PNG 在解码前检查结构和解压大小，包括交错 PNG。
- 不自动下载 HTTP 图片，不接受 SVG 的外部文件、嵌入图片、DTD 或实体声明。图片缺失、格式损坏或终端不支持时，保留说明、原因和路径。
- 改动图片后用 `refresh`；插件不持续监视文件。源缓存保留最多 64 张图或 32 MiB，栅格缓存最多 128 个布局或 32 MiB。最终像素布局不变时，调整窗口宽度或更换图题会复用图像，不重复栅格化；每个图题仍保留自己的复制来源。超出容量的旧图可能退回文字与路径，不会持续反复读取。
- **全屏 TUI 内的选择复制**会把图片还原成可用的 Markdown；引用式图片会补全目的路径。普通终端自身的鼠标复制仍可能得到 Kitty 占位字符。
- 修改的是显示组件，不会用终端图像数据替换会话里的原始 Markdown。RPC/非 TUI 模式不接管渲染。
- 插图开关遵守 Pi 的 `terminal.showImages`；该设置关闭时，先在 Pi 设置中启用它。
- 为复用上游配置，公式和图像通道仍兼容 `PI_BETTER_RENDER_*` 环境变量。`PI_BETTER_RENDER_IMAGES=off` 会关闭图像通道。需要完全禁止上游可选资源下载时，启动时设置 `PI_BETTER_RENDER_FONT_DOWNLOAD=0` 和 `PI_BETTER_RENDER_MERMAID_INSTALL=0`。插图本身不下载字体。

Pi 暂未提供助手 Markdown 组件替换 API，因此仍采用上游的组件补丁方式，保留原生 Markdown slot 和显示变换。Pi 升级后应先在临时会话验证，再用于日常会话。

## 开发与检查

```fish
npm ci
npm run check
```

自动测试覆盖图文顺序、流式语法、引用路径、长宽比、底板像素、长图高度、缓存复用与溢出、复制、PNG 解码限制、丢失文件恢复、终端清屏、组件生命周期、原文不变和渲染器冲突。布局回归测试还覆盖中文代码换行、嵌套窄窗口、行内代码原文、提示块引用、完整公式换行，以及换行后文字、样式和链接的保留。

在 Linux Wayland / Kitty 0.50.0 环境可运行独立的真实终端截图检查：

```fish
bash tools/visual-smoke.sh
```

脚本使用临时 HOME、单独的远控 socket 和隐藏窗口，不读取用户的 Pi 凭据，不调用模型；退出时关闭自己的测试窗口。截图保存到 `artifacts/visual-smoke/`，检查宽屏、滚动、窄屏和浅色主题的实际显示。`tools/visual-fixture.ts` 还提供 `/visual-fixture stream` 和 `/visual-fixture native`，用于流式输出及原生工具图片共存检查。

来源与许可见 [THIRD_PARTY.md](THIRD_PARTY.md)；MIT 许可见 [LICENSE](LICENSE)。
