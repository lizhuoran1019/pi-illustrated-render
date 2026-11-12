/** Authoring tools produce reusable Markdown paths, not duplicate tool-card images. */
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { copyFile, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DiagramCache, type DiagramRecord } from "./cache.ts";
import type { DiagramInput } from "./render.ts";

const params = Type.Object({
	source: Type.String({ minLength: 1, maxLength: 50_000, description: "Mermaid source or standalone SVG, according to the tool. No Markdown fences." }),
	caption: Type.String({ minLength: 1, maxLength: 160, description: "Short caption for the figure, in the answer's language." }),
	exportPath: Type.Optional(Type.String({ description: "Optional permanent .svg file. Use only when the user asks to save/export; omit for ordinary explanations. Existing files are never overwritten." })),
});
interface DiagramDetails { diagram: DiagramRecord; path: string; managed: boolean }

function captionText(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim(); }
export function diagramMarkdown(caption: string, path: string): string {
	const href = pathToFileURL(path).href.replace(/\(/g, "%28").replace(/\)/g, "%29");
	return `![${captionText(caption).replace(/[\\[\]]/g, "\\$&")}](${href})`;
}

/** One current-branch recipe set; no global session scan, external manifest or binary history. */
export function registerDiagramTools(pi: ExtensionAPI, root = () => join(getAgentDir(), "cache", "pi-illustrated-render", "diagrams")) {
	let cache: DiagramCache | undefined;
	function reconstruct(ctx: ExtensionContext): void {
		const recipes: unknown[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
			if (entry.message.toolName !== "render_mermaid" && entry.message.toolName !== "render_svg") continue;
			recipes.push((entry.message.details as Partial<DiagramDetails> | undefined)?.diagram);
		}
		cache!.restore(recipes);
	}
	function current(ctx: ExtensionContext): DiagramCache {
		if (!cache) { cache = new DiagramCache(root()); reconstruct(ctx); }
		return cache;
	}

	for (const format of ["mermaid", "svg"] as const) {
		const name = `render_${format}`;
		pi.registerTool({
			name,
			label: format === "mermaid" ? "Mermaid 图示" : "自定义 SVG 图示",
			description: format === "mermaid"
				? "Render Mermaid locally with Pele to a self-contained SVG. Returns a Markdown image reference to embed between explanatory paragraphs. Prefer this for diagrams Mermaid can express; fix reported syntax errors before using the result."
				: "Render a self-contained vector SVG when Mermaid cannot express the needed geometry or notation. Returns a Markdown image reference. No scripts, foreignObject, embedded images, external resources or file reads.",
			promptSnippet: format === "mermaid" ? "Render a Mermaid diagram with local Pele; return an inline Markdown image reference" : "Render a custom vector diagram when Mermaid is unsuitable",
			promptGuidelines: [
				`Embed the Markdown reference returned by ${name} in its own paragraph beside the explanation. Omit exportPath unless a permanent export was requested; ordinary output uses a bounded, recoverable cache.`,
			],
			parameters: params,
			async execute(_toolCallId, input, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const caption = captionText(input.caption);
				if (!caption) throw new Error("请提供简短图注");
				let exportPath: string | undefined;
				if (input.exportPath !== undefined) {
					let value = input.exportPath.replace(/^@/, "");
					if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("导出路径不能为空或包含控制字符");
					if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
					exportPath = resolve(ctx.cwd, value);
					if (extname(exportPath).toLowerCase() !== ".svg") throw new Error("导出路径须使用 .svg 扩展名");
					const cacheRoot = resolve(root());
					if (exportPath === cacheRoot || exportPath.startsWith(cacheRoot + sep)) throw new Error("永久导出请选缓存目录以外的位置");
				}
				const store = current(ctx);
				const diagram = await store.create({ format, source: input.source } satisfies DiagramInput, signal);
				let path = store.path(diagram.id);
				if (exportPath !== undefined) {
					await mkdir(dirname(exportPath), { recursive: true });
					const destination = join(await realpath(dirname(exportPath)), basename(exportPath));
					const managedRoot = await realpath(store.root);
					if (destination === managedRoot || destination.startsWith(managedRoot + sep)) throw new Error("永久导出请选缓存目录以外的位置（包括符号链接的目标）");
					await withFileMutationQueue(destination, async () => {
						signal?.throwIfAborted();
						await copyFile(path, destination, constants.COPYFILE_EXCL);
					});
					path = destination;
				}
				const details: DiagramDetails = { diagram, path, managed: exportPath === undefined };
				return {
					content: [{ type: "text", text: `${diagramMarkdown(caption, path)}\n\n${Math.round(diagram.width)} × ${Math.round(diagram.height)} px · ${details.managed ? "可回收缓存；会话保留重建源码" : "已保存永久 SVG 导出"}` }],
					details,
				};
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold(name)) + (args.caption ? ` · ${captionText(args.caption)}` : ""), 0, 0);
			},
			renderResult(result, _options, theme) {
				const details = result.details as DiagramDetails | undefined;
				if (!details?.diagram) return new Text(result.content.map((item) => item.type === "text" ? item.text : "").join("\n"), 0, 0);
				return new Text(theme.fg("success", "✓ 图示已生成") + theme.fg("muted", ` · ${details.managed ? "可回收缓存" : "永久导出"}\n${details.path}`), 0, 0);
			},
		});
	}

	return {
		async start(ctx: ExtensionContext) {
			cache?.dispose(); cache = new DiagramCache(root()); reconstruct(ctx);
			try { await cache.prune(); } catch (error) { ctx.ui.notify(`图示缓存清理失败：${String(error)}`, "warning"); }
		},
		restore(ctx: ExtensionContext) { current(ctx); reconstruct(ctx); },
		resolvePath(path: string): string { return cache?.resolvePath(path) ?? path; },
		async prepare(path: string): Promise<void> { await cache?.prepare(path); },
		async status(ctx: ExtensionContext): Promise<string> {
			const store = current(ctx), report = await store.status();
			return `生成图缓存：${report.files} 张 / 512 张 · ${(report.bytes / 1024 / 1024).toFixed(1)} MiB / 256 MiB\n30 天未使用或超出容量时自动清理；会话源码可重建。\n${store.root}`;
		},
		async clear(ctx: ExtensionContext): Promise<string> {
			const report = await current(ctx).clear();
			return `已清理 ${report.removedFiles} 张生成图（${(report.removedBytes / 1024 / 1024).toFixed(1)} MiB）。当前视图用到的图会按需重建；导出文件不受影响。`;
		},
		stop() { cache?.dispose(); cache = undefined; },
	};
}
