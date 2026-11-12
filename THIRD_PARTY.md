# 来源与许可

## pi-better-render 0.5.0 — MIT

来源：<https://github.com/JeffeyChou/pi-better-render>

Copyright (c) 2026 Jiefeng Zhou。原 MIT 许可及版权声明保留在根目录 `LICENSE`。

本插件从该版本的源代码派生，复用公式引擎集成、Kitty 图像传输、选择复制和 Markdown 排版。新增本地插图服务，修改助手组件补丁、缓存标识和生命周期。

上游的 Kitty Unicode 行列附加符号表注明来自 `Fadouse/pi-math`（MIT）及 Kitty 的 `rowcolumn-diacritics.txt`；该来源注释保留在 `src/math/kitty.ts`。

## MathJax — Apache-2.0

`vendor/` 是随 pi-better-render 0.5.0 分发的预构建文件，保留其内容与 Apache-2.0 许可 `vendor/LICENSE`。模块和版本列在 `vendor/README.md`，主要为 MathJax 4.1.3 和 mhchemparser 4.2.1。

## Pele 1.13.0 — MIT

来源：<https://github.com/obsidianmd/pele>；Copyright (c) 2026 kepano。

作为 npm 运行依赖使用其本地 Mermaid → SVG 渲染器。未复制包源码；完整许可及其附带组件声明由 `pele/LICENSE` 随依赖分发。

## npm 依赖

- `@resvg/resvg-js`：MIT，SVG 排版与栅格化。
- `pngjs`：MIT，PNG 解码与 CRC 检查；解码前由本插件执行有界预检。
- `typebox`：MIT，工具参数 schema；与 Pi host 一样作为 peer dependency 使用。
- Pi host 包作为 peer dependency，由宿主提供；开发依赖固定到实测的 Pi 1.5.2。

依赖完整的许可文本随各包分发。示例 SVG、PNG 和物理讲义由本项目制作，按根目录 MIT 许可提供。
