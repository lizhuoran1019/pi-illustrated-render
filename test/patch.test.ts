import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, setCellDimensions, stripTerminalSequences } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER } from "../src/math/kitty.ts";
import { loadMathJax } from "../src/math/mathjax.ts";
import extension, { hasCompetingRenderer } from "../src/index.ts";
import { installDirectRedraw } from "../src/direct-redraw.ts";
import { applyPatch, isPatched, removePatch } from "../src/patch.ts";
import { RichMarkdown } from "../src/render/rich-markdown.ts";
import { noMath } from "../src/render/context.ts";
import { state } from "../src/state.ts";
import { plainStyle } from "../src/style.ts";

const original = AssistantMessageComponent.prototype.updateContent;
type Message = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
const message = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });
const render = (c: AssistantMessageComponent) => c.render(90).map(stripTerminalSequences).join("\n");

const initialAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-diagram-hooks-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	initTheme("dark"); state.enabled = state.imagesAllowed = state.illustrations = true; state.math = "streaming"; state.imageBackground = "none"; state.imageMaxRows = 28;
});
afterEach(async () => {
	removePatch(); AssistantMessageComponent.prototype.updateContent = original;
	if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

test("actual assistant slots survive repeated streaming updates; transforms and stored content stay intact", () => {
	let calls = 0;
	applyPatch((text, paddingX, streaming, transform) => new RichMarkdown(text, { style: plainStyle(), math: noMath, streaming, paddingX, transform }));
	const saved = message("first");
	const snapshot = JSON.stringify(saved);
	const component = new AssistantMessageComponent(saved, false, undefined, undefined, 1, [(text, context) => { calls++; assert.equal(context.messageType, "assistant"); return text.toUpperCase(); }]);
	assert.match(render(component), /FIRST/);
	assert.equal(calls, 1);
	for (const text of ["first second", "first second third", "final"]) {
		component.updateContent(message(text), text !== "final");
		assert.ok(render(component).includes(text.toUpperCase()));
	}
	assert.equal(calls, 4);
	assert.equal(JSON.stringify(saved), snapshot);
	assert.equal(isPatched(), true);
});

test("on/off affects existing components immediately; removal restores the native entry point", () => {
	applyPatch(() => ({ render: () => ["ILLUSTRATED"], invalidate() {} }));
	const component = new AssistantMessageComponent(message("Native"));
	assert.match(render(component), /ILLUSTRATED/);
	state.enabled = false;
	assert.match(render(component), /Native/);
	state.enabled = true;
	assert.match(render(component), /ILLUSTRATED/);
	removePatch();
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	assert.match(render(component), /Native/);
});

test("upstream ownership is refused and later wrappers are not overwritten on shutdown", () => {
	const proto = AssistantMessageComponent.prototype as unknown as Record<symbol, unknown>;
	const upstream = Symbol.for("pi-better-render.assistant-patch");
	proto[upstream] = {};
	try { assert.equal(applyPatch(() => ({ render: () => [], invalidate() {} })), false); }
	finally { delete proto[upstream]; }
	assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	applyPatch(() => ({ render: () => ["ours"], invalidate() {} }));
	const ours = AssistantMessageComponent.prototype.updateContent;
	const later: typeof ours = function (this: AssistantMessageComponent, m, streaming) { ours.call(this, m, streaming); };
	AssistantMessageComponent.prototype.updateContent = later;
	removePatch();
	assert.equal(AssistantMessageComponent.prototype.updateContent, later);
	assert.match(render(new AssistantMessageComponent(message("Native"))), /Native/);
});

test("conflict detection uses registered source metadata before startup ordering matters", () => {
	const commands = [{ name: "renamed", source: "extension", sourceInfo: { path: "/tmp/pi-better-render/src/index.ts", source: "npm:pi-better-render", scope: "user", origin: "package" } }] satisfies ReturnType<ExtensionAPI["getCommands"]>;
	assert.equal(hasCompetingRenderer(commands), true);
	assert.equal(hasCompetingRenderer([]), false);
});

test("an exact command argument closes completion so Enter submits it", async () => {
	let definition: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const api = { on() {}, registerTool() {}, registerCommand: (_name: string, command: NonNullable<typeof definition>) => { definition = command; } } as unknown as ExtensionAPI;
	extension(api);
	assert.deepEqual(await definition!.getArgumentCompletions!("images:off"), []);
	const matches = await definition!.getArgumentCompletions!("images:o");
	assert.deepEqual(matches?.map((item) => item.value), ["images:on", "images:off"]);
});

test("image controls validate height, update cache identity and expose current limits to the author", async () => {
	const hooks = new Map<string, (...args: any[]) => any>();
	let definition: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const notices: { text: string; level: string }[] = [];
	let activeTools = ["render_mermaid", "render_svg"];
	let renders = 0;
	const tui = { mode: "fullscreen", terminal: { write() {} }, invalidate() {}, requestRender() { renders++; }, getActiveSelectionText() { return undefined; } };
	const ctx = { mode: "tui", cwd: "/tmp", sessionManager: { getBranch: () => [] }, ui: {
		setWidget(_name: string, factory?: (tui: unknown) => unknown) { factory?.(tui); },
		notify(text: string, level: string) { notices.push({ text, level }); },
	} };
	const api = {
		on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); },
		registerCommand(_name: string, command: NonNullable<typeof definition>) { definition = command; },
		getCommands: () => [], getSettings: () => ({ terminal: { showImages: true } }),
		registerTool() {}, getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	extension(api);
	await hooks.get("session_start")!({}, ctx);
	const run = (arg: string) => definition!.handler(arg, ctx as any);
	try {
		assert.equal(isPatched(), true);
		for (const background of ["light", "dark", "none"]) {
			await run(`images:bg:${background}`);
			assert.equal(state.imageBackground, background);
		}
		await run("images:height:56"); assert.equal(state.imageMaxRows, 56);
		const version = state.version, frames = renders;
		for (const invalid of ["", "7", "121", "28.5", "nan", "-28"]) {
			await run(`images:height:${invalid}`);
			assert.equal(state.imageMaxRows, 56);
			assert.equal(notices.at(-1)!.level, "error");
			assert.match(notices.at(-1)!.text, /8–120/);
		}
		assert.equal(state.version, version); assert.equal(renders, frames);
		await run("status"); assert.match(notices.at(-1)!.text, /56 行/);
		const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
		hooks.get("before_agent_start")!(prompt);
		assert.match(prompt.systemPromptOptions.sections.illustrated_render!, /56 terminal rows/);
		assert.match(prompt.systemPromptOptions.sections.illustrated_render!, /display math/);
		assert.match(prompt.systemPromptOptions.sections.illustrated_render!, /prefer render_mermaid/);
		assert.match(prompt.systemPromptOptions.sections.illustrated_render!, /bounded cache/);
		assert.ok(!prompt.systemPromptOptions.sections.illustrated_render!.includes("physics"));
		assert.ok(!prompt.systemPromptOptions.sections.illustrated_render!.includes(".pi/diagrams"));
		activeTools = ["render_mermaid"];
		const limited = { systemPromptOptions: { sections: {} as Record<string, string> } };
		hooks.get("before_agent_start")!(limited);
		assert.match(limited.systemPromptOptions.sections.illustrated_render!, /render_mermaid/);
		assert.ok(!limited.systemPromptOptions.sections.illustrated_render!.includes("render_svg"));
		activeTools = [];
		const disabled = { systemPromptOptions: { sections: {} as Record<string, string> } };
		hooks.get("before_agent_start")!(disabled);
		assert.equal(disabled.systemPromptOptions.sections.illustrated_render, undefined);
		assert.deepEqual(await definition!.getArgumentCompletions!("images:bg:light"), []);
		assert.deepEqual(await definition!.getArgumentCompletions!("images:height:56"), []);
	} finally { hooks.get("session_shutdown")!(); }
	assert.equal(isPatched(), false);
});

/** Actual extension lifecycle and terminal hook, with output kept in memory. */
async function terminalHarness(showImages: boolean) {
	const hooks = new Map<string, (...args: any[]) => any>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const settings = { terminal: { showImages } };
	const notices: string[] = [], writes: string[] = [];
	const tui = { mode: "fullscreen", terminal: { write(data: string) { writes.push(data); } }, invalidate() {}, requestRender() {}, doRender() {}, resetRenderState() {}, getActiveSelectionText() { return undefined; } };
	const ctx = { mode: "tui", cwd: fileURLToPath(new URL("../", import.meta.url)), sessionManager: { getBranch: () => [] }, ui: {
		setWidget(_name: string, factory?: (tui: unknown) => unknown) { factory?.(tui); },
		notify(text: string) { notices.push(text); },
	} };
	extension({
		on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); },
		registerCommand(_name: string, definition: NonNullable<typeof command>) { command = definition; },
		getCommands: () => [], getSettings: () => settings,
		registerTool() {}, getActiveTools: () => ["render_mermaid", "render_svg"],
	} as unknown as ExtensionAPI);
	await hooks.get("session_start")!({}, ctx);
	return {
		settings, notices,
		run: (arg: string) => command!.handler(arg, ctx as any),
		frame: (component: AssistantMessageComponent) => { writes.length = 0; tui.terminal.write(component.render(90).join("\n")); return writes.join(""); },
		prompt: () => { const event = { systemPromptOptions: { sections: {} as Record<string, string> } }; hooks.get("before_agent_start")!(event); return event.systemPromptOptions.sections; },
		stop: () => hooks.get("session_shutdown")!(),
	};
}

test("entity controls cannot reach the actual assistant terminal writer; normal links survive", async () => {
	const h = await terminalHarness(false);
	try {
		const stored = message("**text** &#27;[2J &#x9b;2J &#27;]52;c;YQ==&#7; [guide](https://example.com)");
		const snapshot = JSON.stringify(stored);
		const output = h.frame(new AssistantMessageComponent(stored));
		// Native OSC 133 shell-integration markers legitimately contain BEL.
		assert.ok(!output.includes("\x1b[2J") && !output.includes("\x9b") && !output.includes("\x1b]52;"), JSON.stringify(output));
		assert.ok(output.includes("&#27;") && output.includes("&#x9b;") && output.includes("YQ==&#7;"));
		assert.ok(output.includes("\x1b]8;;https://example.com"));
		assert.equal(JSON.stringify(stored), snapshot);
	} finally { h.stop(); }
});

test("terminal image permission covers math and illustrations, including cached components and forced protocols", async () => {
	const caps = getCapabilities(), previous = process.env.PI_BETTER_RENDER_IMAGES;
	setCapabilities({ ...caps, images: "kitty" });
	setCellDimensions({ widthPx: 8, heightPx: 16 });
	assert.ok(await loadMathJax());
	try {
		for (const mode of [undefined, "placeholder", "direct"]) {
			if (mode === undefined) delete process.env.PI_BETTER_RENDER_IMAGES; else process.env.PI_BETTER_RENDER_IMAGES = mode;
			const h = await terminalHarness(false);
			try {
				const stored = message("$x+y$\n\n$$x^2$$\n\n![diagram](examples/electric-field.png)");
				const snapshot = JSON.stringify(stored);
				const component = new AssistantMessageComponent(stored);
				const disabled = () => {
					const output = h.frame(component);
					assert.ok(!output.includes(PLACEHOLDER) && !output.includes("\x1b_G"));
					assert.match(stripTerminalSequences(output), /终端图片已关闭/);
					assert.ok(!h.prompt().illustrated_render);
				};
				disabled();
				await h.run("images:on"); await h.run("math:streaming"); disabled();
				await h.run("status"); assert.match(h.notices.at(-1)!, /terminal.showImages/);
				// No reload or component replacement: render-time permission sync
				// must invalidate both math and illustration caches in either direction.
				h.settings.terminal.showImages = true;
				await h.run("images:off");
				const allowed = h.frame(component);
				assert.ok(allowed.includes("\x1b_Ga="), "images:off must not turn off formula images");
				assert.match(stripTerminalSequences(allowed), /图片显示已关闭/);
				h.settings.terminal.showImages = false; disabled();
				h.settings.terminal.showImages = true;
				await h.run("images:on");
				assert.ok(h.prompt().illustrated_render);
				assert.equal(JSON.stringify(stored), snapshot);
			} finally { h.stop(); }
		}
	} finally {
		setCapabilities(caps);
		if (previous === undefined) delete process.env.PI_BETTER_RENDER_IMAGES; else process.env.PI_BETTER_RENDER_IMAGES = previous;
	}
});

test("direct fullscreen frames reset only on real renders and release their instance hook", () => {
	const calls: string[] = [];
	const host = { mode: "fullscreen", uploadedKittyImages: new Map([[123, {}]]), resetRenderState() { calls.push("reset"); }, doRender() { calls.push("render"); } };
	const originalRender = host.doRender;
	let stop = installDirectRedraw(host, "placeholder");
	assert.equal(host.doRender, originalRender); stop();
	host.mode = "normal"; stop = installDirectRedraw(host, "direct");
	assert.equal(host.doRender, originalRender); stop();
	host.mode = "fullscreen"; stop = installDirectRedraw(host, "direct");
	assert.deepEqual(calls, [], "installing must not schedule any extra render");
	assert.equal(host.uploadedKittyImages.size, 1, "other modes and installing preserve native image state");
	host.doRender(); host.doRender();
	assert.deepEqual(calls, ["reset", "render", "reset", "render"]);
	assert.equal(host.uploadedKittyImages.size, 0, "full direct frames reupload native PNGs as well");
	stop(); assert.equal(host.doRender, originalRender);
	stop = installDirectRedraw(host, "direct");
	const ours = host.doRender;
	const later = () => ours.call(host);
	host.doRender = later;
	stop(); assert.equal(host.doRender, later);
	calls.length = 0; host.doRender(); assert.deepEqual(calls, ["render"]);
	assert.throws(() => installDirectRedraw({ mode: "fullscreen" }, "direct"), /placeholder/);
});

test("extension never registers context/message mutation hooks and skips RPC rendering", async () => {
	const hooks = new Map<string, (...args: any[]) => any>();
	const api = { on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	extension(api);
	assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start", "session_tree"]);
	await hooks.get("session_start")!({}, { mode: "rpc", sessionManager: { getBranch: () => [] } });
	assert.equal(isPatched(), false);
});
