import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, mkdir, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DiagramCache, isDiagramRecord } from "../src/diagrams/cache.ts";
import { diagramMarkdown, registerDiagramTools } from "../src/diagrams/tools.ts";
import { lexInline } from "../src/render/lexer.ts";
import { IllustrationService, resolveImagePath } from "../src/illustrations.ts";
import { getCapabilities, setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { state } from "../src/state.ts";

let root: string;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#336699"/></svg>';
const fakeRender = async () => ({ svg, width: 80, height: 40 });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-diagram-cache-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("disk cache bounds count/bytes/age, touches hits and reconstructs expired source after reload", async () => {
	let now = 1_800_000_000_000, renders = 0;
	const render = async () => { renders++; return fakeRender(); };
	const cache = new DiagramCache(join(root, "cache"), { maxBytes: svg.length * 2, maxFiles: 2, maxAgeMs: 100, now: () => now, render });
	const a = await cache.create({ format: "mermaid", source: "graph TD; A-->B" }); now++;
	const b = await cache.create({ format: "mermaid", source: "graph TD; C-->D" }); now++;
	await cache.prepare(a.path); now++;
	const c = await cache.create({ format: "mermaid", source: "graph TD; E-->F" });
	assert.equal((await cache.status()).files, 2);
	assert.equal(await readFile(a.path, "utf8"), svg);
	await assert.rejects(readFile(b.path), { code: "ENOENT" });
	assert.equal((await cache.create({ format: a.format, source: a.source })).id, a.id);
	assert.equal(renders, 3, "same source/other caption need not generate another file");
	now += 101;
	assert.equal((await cache.prune()).files, 0);
	cache.dispose();
	const resumed = new DiagramCache(join(root, "cache"), { render });
	resumed.restore([a, b, c]);
	await Promise.all([resumed.prepare(a.path), resumed.prepare(a.path)]);
	assert.equal(renders, 4, "concurrent reconstruction is deduplicated");
	assert.equal(await readFile(a.path, "utf8"), svg);
	assert.equal((await resumed.clear()).files, 0);
	await resumed.prepare(a.path);
	assert.equal(await readFile(a.path, "utf8"), svg, "clear preserves the recipe");
});

test("cleanup only owns generated regular files; unknown files, symlinks, exports and active writes survive", async () => {
	const dir = join(root, "cache"), userFile = join(root, "user.svg");
	const cache = new DiagramCache(dir, { render: fakeRender });
	const record = await cache.create({ format: "svg", source: svg });
	await writeFile(userFile, "USER DATA");
	await writeFile(join(dir, "unrelated.svg"), "KEEP");
	await symlink(userFile, join(dir, `diagram-${randomUUID()}.svg`));
	await mkdir(join(dir, `diagram-${randomUUID()}.svg`));
	const stale = join(dir, `.writing-${randomUUID()}`), active = join(dir, `.writing-${randomUUID()}`);
	await writeFile(stale, "interrupted"); await writeFile(active, "in progress");
	await utimes(stale, new Date(0), new Date(0));
	assert.equal((await cache.clear()).removedFiles, 2);
	assert.equal(await readFile(userFile, "utf8"), "USER DATA");
	assert.equal(await readFile(join(dir, "unrelated.svg"), "utf8"), "KEEP");
	assert.equal(await readFile(active, "utf8"), "in progress");
	await assert.rejects(readFile(record.path), { code: "ENOENT" });
	const alias = join(root, "alias"); await symlink(dir, alias);
	await assert.rejects(new DiagramCache(alias).clear(), /符号链接/);
});

test("restored paths are aliases, not write authority; branch changes and corrupt recipes do not recreate files", async () => {
	const first = new DiagramCache(join(root, "old"), { render: fakeRender });
	const record = await first.create({ format: "svg", source: svg });
	await first.clear(); first.dispose();
	const second = new DiagramCache(join(root, "new"), { render: fakeRender });
	second.restore([record, { ...record, id: "../../escape" }, { ...record, source: "x".repeat(50_001) }]);
	assert.equal(isDiagramRecord({ ...record, format: "shell" }), false);
	assert.equal(second.resolvePath(record.path), second.path(record.id));
	await second.prepare(record.path);
	assert.equal(await readFile(second.path(record.id), "utf8"), svg);
	await assert.rejects(readFile(record.path), { code: "ENOENT" });
	await second.clear(); second.restore([]); await second.prepare(record.path);
	assert.deepEqual(await readdir(join(root, "new")), []);
});

test("concurrent creations stay within the cache; cancellation and oversized output leave no file", async () => {
	const dir = join(root, "cache");
	const cache = new DiagramCache(dir, { maxFiles: 2, render: fakeRender });
	await Promise.all(Array.from({ length: 5 }, (_, i) => cache.create({ format: "mermaid", source: `graph TD; A-->B${i}` })));
	assert.equal((await cache.status()).files, 2);
	assert.ok((await readdir(dir)).every((name) => name.startsWith("diagram-")));
	const cancelled = new AbortController(); cancelled.abort();
	await assert.rejects(cache.create({ format: "svg", source: svg }, cancelled.signal), { name: "AbortError" });
	const small = new DiagramCache(join(root, "small"), { maxBytes: 10, render: fakeRender });
	await assert.rejects(small.create({ format: "svg", source: svg }), /容量/);
	await assert.rejects(readdir(join(root, "small")), { code: "ENOENT" });
});

test("managed source provider restores missing images without changing ordinary local-file callers", async () => {
	const caps = getCapabilities(), mode = process.env.PI_BETTER_RENDER_IMAGES;
	setCapabilities({ ...caps, images: "kitty" }); process.env.PI_BETTER_RENDER_IMAGES = "placeholder";
	setCellDimensions({ widthPx: 8, heightPx: 16 }); state.imagesAllowed = state.illustrations = true;
	const cache = new DiagramCache(join(root, "cache"), { render: fakeRender });
	const record = await cache.create({ format: "svg", source: svg }); await cache.clear();
	const service = new IllustrationService(root, () => {}, cache);
	const image = { href: record.path, alt: "图", source: `![图](${record.path})` };
	try {
		assert.equal(service.block(image, 60).status, "fallback");
		await service.idle();
		assert.equal(service.block(image, 60).status, "ready");
		assert.equal(await readFile(record.path, "utf8"), svg);
		state.imagesAllowed = false; service.clear(); await cache.clear();
		service.block(image, 60); await service.idle();
		await assert.rejects(readFile(record.path), { code: "ENOENT" }, "permission-off must not rebuild a file");
	} finally {
		service.dispose(); cache.dispose(); setCapabilities(caps); state.imagesAllowed = true;
		if (mode === undefined) delete process.env.PI_BETTER_RENDER_IMAGES; else process.env.PI_BETTER_RENDER_IMAGES = mode;
	}
});

test("image Markdown round-trips filenames and parent directories with parentheses", () => {
	for (const path of [join(root, "figure).svg"), join(root, "图) (片", "图 [A]#%.svg")]) {
		const tokens = lexInline(diagramMarkdown("节点 [A]", path));
		assert.equal(tokens.length, 1);
		const image = tokens[0] as { type: string; href: string };
		assert.equal(image.type, "image");
		assert.equal(resolveImagePath(image.href, root), path);
	}
});

test("registered tools return inline references, save source-only details, export exclusively and recover the active branch", async () => {
	const tools = new Map<string, ToolDefinition>();
	let branch: any[] = [];
	const api = { registerTool(definition: ToolDefinition) { tools.set(definition.name, definition); } } as unknown as ExtensionAPI;
	const ctx = { cwd: root, sessionManager: { getBranch: () => branch }, ui: { notify() {} } } as unknown as ExtensionContext;
	const controller = registerDiagramTools(api, () => join(root, "cache")); await controller.start(ctx);
	const tool = tools.get("render_svg")!;
	const result = await tool.execute("first", { source: svg, caption: "节点 [A]" }, undefined, undefined, ctx as any);
	const details = result.details as any;
	assert.ok(result.content.every((item) => item.type === "text"));
	assert.match((result.content[0] as any).text, /^!\[节点 \\\[A\\\]\]\(file:/);
	assert.equal(details.diagram.source, svg);
	assert.equal(JSON.stringify(details).includes("base64"), false);
	branch = [{ type: "message", message: { role: "toolResult", toolName: "render_svg", isError: false, details } }];
	await controller.clear(ctx); controller.stop(); await controller.start(ctx);
	await controller.prepare(details.path);
	assert.match(await readFile(details.path, "utf8"), /<svg/);
	const exported = await tool.execute("export", { source: svg, caption: "导出", exportPath: "saved.svg" }, undefined, undefined, ctx as any);
	assert.equal((exported.details as any).managed, false);
	await assert.rejects(tool.execute("again", { source: svg, caption: "导出", exportPath: "saved.svg" }, undefined, undefined, ctx as any), { code: "EEXIST" });
	const disguised = join(root, "exports"); await symlink(join(root, "cache"), disguised);
	const permanentName = `diagram-${randomUUID()}.svg`;
	await assert.rejects(tool.execute("symlink-export", { source: svg, caption: "导出", exportPath: join(disguised, permanentName) }, undefined, undefined, ctx as any), /缓存目录以外/);
	await assert.rejects(readFile(join(root, "cache", permanentName)), { code: "ENOENT" });
	const external = join(root, "outside"), externalAlias = join(root, "outside-alias");
	await mkdir(external); await symlink(external, externalAlias);
	const linkedExport = await tool.execute("valid-symlink", { source: svg, caption: "导出", exportPath: join(externalAlias, "figure).svg") }, undefined, undefined, ctx as any);
	assert.equal((linkedExport.details as any).path, join(external, "figure).svg"));
	await controller.clear(ctx);
	assert.match(await readFile(join(root, "saved.svg"), "utf8"), /<svg/);
	assert.match(await readFile(join(external, "figure).svg"), "utf8"), /<svg/);
	branch = []; controller.restore(ctx); await controller.prepare(details.path);
	await assert.rejects(readFile(details.path), { code: "ENOENT" });
	assert.match(await controller.status(ctx), /256 MiB/);
	controller.stop();
});
