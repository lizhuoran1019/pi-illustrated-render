/** pi-illustrated-render: display-only assistant Markdown with local illustrations. */
import { type ExtensionAPI, type ExtensionContext, copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { IllustrationService } from "./illustrations.ts";
import { forgetFormulaSources, installCopyHook, type SelectionHost } from "./math/copy.ts";
import { createMathRenderer, clearFormulaCache } from "./math/formula.ts";
import { deleteImages, forgetImages, imageMode, installFrameHook } from "./math/kitty.ts";
import { loadMathJax, mathjaxError, mathjaxReady } from "./math/mathjax.ts";
import { applyPatch, removePatch } from "./patch.ts";
import { clearLexCache } from "./render/lexer.ts";
import { clearBlockCache, RichMarkdown } from "./render/rich-markdown.ts";
import { bumpVersion, setRenderRequester, state } from "./state.ts";
import { createStyle, plainStyle, type Style, styleKey } from "./style.ts";

let ui: ExtensionContext["ui"] | undefined;
let tui: { mode?: string; requestRender?: () => void; invalidate?: () => void; terminal?: { write(data: string): void } } | undefined;
let uninstallFrameHook: (() => void) | undefined;
let uninstallCopyHook: (() => void) | undefined;
let illustrations: IllustrationService | undefined;
let active = false;
let lifecycle = 0;
let inactiveReason = "仅在交互式 TUI 中启用";
let styleCache: { colors: unknown; key: string; style: Style } | undefined;

function currentStyle(): Style {
	const theme = ui?.theme;
	if (!theme) return plainStyle();
	const colors = theme.colors;
	if (styleCache && colors !== undefined && colors === styleCache.colors) return styleCache.style;
	const key = styleKey(theme);
	if (styleCache?.key === key) { styleCache.colors = colors; return styleCache.style; }
	const md = getMarkdownTheme();
	const style = createStyle(theme, (code, lang) => md.highlightCode?.(code, lang), key);
	styleCache = { colors, key, style };
	return style;
}

const math = createMathRenderer(() => currentStyle().mathColor);

function refreshAll(): void {
	bumpVersion();
	tui?.invalidate?.();
	tui?.requestRender?.();
}

function dropCaches(freeImages: boolean): void {
	illustrations?.clear();
	clearBlockCache();
	clearLexCache();
	clearFormulaCache();
	forgetFormulaSources();
	if (freeImages) deleteImages(tui?.terminal ? (data) => tui!.terminal!.write(data) : undefined);
	else forgetImages();
}

function stop(): void {
	lifecycle++;
	active = false;
	removePatch();
	uninstallFrameHook?.();
	uninstallCopyHook?.();
	uninstallFrameHook = uninstallCopyHook = undefined;
	illustrations?.dispose();
	dropCaches(false);
	illustrations = undefined;
	setRenderRequester(undefined);
	tui = undefined;
	ui = undefined;
	styleCache = undefined;
}

/** Public widget factory exposes the running TUI without starting a second renderer. */
function captureTui(ctx: ExtensionContext): boolean {
	const key = "pi-illustrated-render:probe";
	try {
		ctx.ui.setWidget(key, (instance) => {
			tui = instance;
			return { render: () => [], invalidate() {} };
		});
	} finally {
		ctx.ui.setWidget(key, undefined);
	}
	if (!tui?.terminal) return false;
	setRenderRequester(refreshAll);
	uninstallFrameHook = installFrameHook(tui.terminal);
	uninstallCopyHook = installCopyHook(tui as SelectionHost);
	return true;
}

export function hasCompetingRenderer(commands: ReturnType<ExtensionAPI["getCommands"]>): boolean {
	return commands.some((command) => command.source === "extension" && (
		/(?:^|[/\\])pi-better-render(?:[/\\]|$)/.test(command.sourceInfo.path) ||
		/^npm:pi-better-render(?:@|$)/.test(command.sourceInfo.source) ||
		command.name === "better-render"
	));
}

function statusText(): string {
	if (!active) return `pi-illustrated-render 未启用：${inactiveReason}`;
	return [
		`图文排版：${state.enabled ? "开启" : "关闭"} · 插图：${state.illustrations ? "开启" : "关闭"} · 公式：${state.math}`,
		`图像通道：${imageMode()} · SVG/PNG：本地文件，上限 8 MiB`,
		`公式引擎：${mathjaxReady() ? "MathJax + resvg" : mathjaxError() ?? "加载中…"}`,
	].join("\n");
}

const COMMANDS = ["status", "on", "off", "images:on", "images:off", "math:streaming", "math:final", "math:off", "lines", "mermaid", "refresh", "clear-cache"];

export default function piIllustratedRender(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		if (hasCompetingRenderer(pi.getCommands())) {
			inactiveReason = "请先在 pi config 中禁用 pi-better-render，然后 /reload；两个渲染器不能同时启用";
			ctx.ui.notify(inactiveReason, "warning");
			return;
		}
		ui = ctx.ui;
		try {
			if (!captureTui(ctx)) throw new Error("无法取得 TUI 图像输出通道");
			state.illustrations = pi.getSettings().terminal?.showImages !== false;
			illustrations = new IllustrationService(ctx.cwd);
			if (!applyPatch((text, paddingX, streaming, transform) => new RichMarkdown(text, {
				style: currentStyle, math, illustrations, streaming, paddingX, transform,
				copyCode: tui?.mode === "fullscreen" ? copyToClipboard : undefined,
				onCopyError: (error) => ui?.notify(`复制失败：${String(error)}`, "error"),
				requestRender: () => tui?.requestRender?.(),
			}))) throw new Error("pi-better-render 已接管助手组件；请禁用它后 /reload");
			active = true;
			refreshAll();
			const generation = lifecycle;
			void loadMathJax().then((ok) => { if (ok && active && generation === lifecycle) refreshAll(); });
		} catch (error) {
			stop();
			inactiveReason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`图文渲染未启用：${inactiveReason}`, "warning");
		}
	});

	pi.on("session_shutdown", stop);
	pi.on("before_agent_start", (event) => {
		if (!active || !state.enabled || !state.illustrations || imageMode() === "off") return;
		event.systemPromptOptions.sections.illustrated_render = [
			"The terminal displays local SVG/PNG illustrations inside assistant Markdown.",
			"When an explanation benefits from a diagram (especially physics), create a clear standalone SVG with the available file-writing tools, then place ![short caption](/absolute/path/to/diagram.svg) in its own paragraph, with blank lines before and after. Interleave diagrams with the relevant explanation rather than collecting them at the end.",
			"Use persistent project paths (for example .pi/diagrams/), not temporary files, so resumed sessions retain illustrations. SVGs must be self-contained vectors with no external resources, DTD or embedded images. PNG is also supported. Limits: 8 MiB, 16 million pixels. Use generous labels and a high-contrast background; the image fits within 100 columns and 28 terminal rows. Do not output raw SVG into the reply or download remote images merely to display them.",
		].join("\n");
	});

	pi.registerCommand("illustrated-render", {
		description: "图文渲染：status | on/off | images:on/off | math:streaming/final/off | refresh",
		getArgumentCompletions: (prefix) => COMMANDS.filter((value) => value.startsWith(prefix.trim()) && value !== prefix.trim()).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase() || "status";
			if (arg === "status" || !active) { ctx.ui.notify(statusText(), active ? "info" : "warning"); return; }
			if (arg === "on" || arg === "off") state.enabled = arg === "on";
			else if (arg === "images:on" || arg === "images:off") {
				state.illustrations = arg === "images:on" && pi.getSettings().terminal?.showImages !== false;
			} else if (arg === "math:streaming") state.math = "streaming";
			else if (arg === "math:final") state.math = "final";
			else if (arg === "math:off") state.math = "off";
			else if (arg === "lines") state.lineNumbers = !state.lineNumbers;
			else if (arg === "mermaid") state.mermaid = !state.mermaid;
			else if (arg === "refresh" || arg === "clear-cache") dropCaches(arg === "clear-cache");
			else { ctx.ui.notify(`可用命令：${COMMANDS.join(" | ")}`, "error"); return; }
			refreshAll();
			ctx.ui.notify(statusText(), "info");
		},
	});
}
