/** Assistant Markdown rendering and local, cache-managed diagram authoring. */
import { type ExtensionAPI, type ExtensionContext, copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { IllustrationService } from "./illustrations.ts";
import { installDirectRedraw } from "./direct-redraw.ts";
import { registerDiagramTools } from "./diagrams/tools.ts";
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
let uninstallDirectRedraw: (() => void) | undefined;
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
	uninstallDirectRedraw?.();
	uninstallFrameHook = uninstallCopyHook = uninstallDirectRedraw = undefined;
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
	uninstallDirectRedraw = installDirectRedraw(tui);
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

/** Settings can change without reloading the extension. Recheck before display. */
function syncImagePermission(pi: ExtensionAPI): void {
	const allowed = pi.getSettings().terminal?.showImages !== false;
	if (allowed !== state.imagesAllowed) {
		state.imagesAllowed = allowed;
		bumpVersion();
	}
}

function statusText(): string {
	if (!active) return `pi-illustrated-render 未启用：${inactiveReason}`;
	return [
		`图文排版：${state.enabled ? "开启" : "关闭"} · 插图：${state.illustrations && state.imagesAllowed ? "开启" : "关闭"} · 公式：${state.math}`,
		`终端图片：${state.imagesAllowed ? "允许" : "关闭（terminal.showImages）；公式使用文字"} · 图像通道：${imageMode()}`,
		`插图背景：${state.imageBackground} · 预览高度：${state.imageMaxRows} 行`,
		`SVG/PNG：本地文件，上限 8 MiB · 图下链接可查看原图`,
		`图示工具：Pele Mermaid / SVG · diagrams:cache 查看磁盘缓存`,
		`公式引擎：${mathjaxReady() ? "MathJax + resvg" : mathjaxError() ?? "加载中…"}`,
	].join("\n");
}

const COMMANDS = ["status", "on", "off", "images:on", "images:off", "images:bg:light", "images:bg:dark", "images:bg:none", "images:height:28", "images:height:56", "images:height:84", "math:streaming", "math:final", "math:off", "lines", "mermaid", "diagrams:cache", "diagrams:clear-cache", "refresh", "clear-cache"];

export default function piIllustratedRender(pi: ExtensionAPI): void {
	const diagrams = registerDiagramTools(pi);
	pi.on("session_start", async (_event, ctx) => {
		stop();
		await diagrams.start(ctx);
		if (ctx.mode !== "tui") return;
		if (hasCompetingRenderer(pi.getCommands())) {
			inactiveReason = "请先在 pi config 中禁用 pi-better-render，然后 /reload；两个渲染器不能同时启用";
			ctx.ui.notify(inactiveReason, "warning");
			return;
		}
		ui = ctx.ui;
		try {
			if (!captureTui(ctx)) throw new Error("无法取得 TUI 图像输出通道");
			syncImagePermission(pi);
			state.illustrations = true;
			illustrations = new IllustrationService(ctx.cwd, undefined, diagrams);
			if (!applyPatch((text, paddingX, streaming, transform) => new RichMarkdown(text, {
				style: () => { syncImagePermission(pi); return currentStyle(); }, math, illustrations, streaming, paddingX, transform,
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

	pi.on("session_shutdown", () => { stop(); diagrams.stop(); });
	pi.on("session_tree", (_event, ctx) => {
		diagrams.restore(ctx);
		illustrations?.clear();
		clearBlockCache();
		refreshAll();
	});
	pi.on("before_agent_start", (event) => {
		if (!active) return;
		syncImagePermission(pi);
		if (!state.enabled || !state.imagesAllowed || !state.illustrations || imageMode() === "off") return;
		const available = new Set(pi.getActiveTools());
		if (!available.has("render_mermaid")) return;
		event.systemPromptOptions.sections.illustrated_render = [
			"The terminal displays local SVG/PNG illustrations inside assistant Markdown.",
			"When a diagram helps explain a concept, process, relationship or structure, prefer render_mermaid (local Pele). Repair Mermaid syntax errors.",
			available.has("render_svg") ? "Use render_svg for custom geometry or notation that Mermaid cannot express; a failed Mermaid attempt is not required when it is clearly unsuitable." : "If Mermaid cannot express the diagram, explain it in text or use an existing local figure.",
			"Embed the returned Markdown image reference in its own paragraph with blank lines around it, beside the relevant explanation. Do not gather all figures at the end or paste raw SVG into the reply. Ordinary diagrams belong in the tools\' bounded cache: omit exportPath unless the user asks for a permanent export. The session retains source recipes so cleaned-up cache files can be rebuilt. Do not write explanatory diagrams into persistent project directories merely to display them.",
			`Use generous labels and high contrast; the preview fits within 100 columns and ${state.imageMaxRows} terminal rows and links to the original file. Split dense or tall diagrams into focused illustrations. Put complex fractions, integrals and long equations in display math instead of shrinking them into inline math. Existing local SVG/PNG files can still be embedded directly. Do not download remote images merely to display them.`,
		].join("\n");
	});

	pi.registerCommand("illustrated-render", {
		description: "图文渲染：status | images:on/off | images:bg:light/dark/none | images:height:56 | refresh",
		getArgumentCompletions: (prefix) => COMMANDS.filter((value) => value.startsWith(prefix.trim()) && value !== prefix.trim()).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (active) syncImagePermission(pi);
			const arg = args.trim().toLowerCase() || "status";
			if (arg === "diagrams:cache" || arg === "diagrams:clear-cache") {
				try {
					const text = arg === "diagrams:cache" ? await diagrams.status(ctx) : await diagrams.clear(ctx);
					if (arg === "diagrams:clear-cache") { dropCaches(true); refreshAll(); }
					ctx.ui.notify(text, "info");
				} catch (error) { ctx.ui.notify(`图示缓存操作失败：${String(error)}`, "error"); }
				return;
			}
			if (arg === "status" || !active) { ctx.ui.notify(statusText(), active ? "info" : "warning"); return; }
			if (arg === "on" || arg === "off") state.enabled = arg === "on";
			else if (arg === "images:on" || arg === "images:off") {
				state.illustrations = arg === "images:on";
			} else if (arg === "images:bg:light" || arg === "images:bg:dark" || arg === "images:bg:none") {
				state.imageBackground = arg.slice("images:bg:".length) as typeof state.imageBackground;
			} else if (arg.startsWith("images:height:")) {
				const value = arg.slice("images:height:".length);
				const rows = Number(value);
				if (!/^\d+$/.test(value) || rows < 8 || rows > 120) {
					ctx.ui.notify("预览高度须为 8–120 行的整数，例如 /illustrated-render images:height:56", "error");
					return;
				}
				state.imageMaxRows = rows;
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
