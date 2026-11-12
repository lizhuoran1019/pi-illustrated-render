import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { AssistantMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import extension, { hasCompetingRenderer } from "../src/index.ts";
import { applyPatch, isPatched, removePatch } from "../src/patch.ts";
import { RichMarkdown } from "../src/render/rich-markdown.ts";
import { noMath } from "../src/render/context.ts";
import { state } from "../src/state.ts";
import { plainStyle } from "../src/style.ts";

const original = AssistantMessageComponent.prototype.updateContent;
type Message = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
const message = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });
const render = (c: AssistantMessageComponent) => c.render(90).map(stripTerminalSequences).join("\n");

beforeEach(() => { initTheme("dark"); state.enabled = true; state.imageBackground = "none"; state.imageMaxRows = 28; });
afterEach(() => { removePatch(); AssistantMessageComponent.prototype.updateContent = original; });

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
	const api = { on() {}, registerCommand: (_name: string, command: NonNullable<typeof definition>) => { definition = command; } } as unknown as ExtensionAPI;
	extension(api);
	assert.deepEqual(await definition!.getArgumentCompletions!("images:off"), []);
	const matches = await definition!.getArgumentCompletions!("images:o");
	assert.deepEqual(matches?.map((item) => item.value), ["images:on", "images:off"]);
});

test("image controls validate height, update cache identity and expose current limits to the author", async () => {
	const hooks = new Map<string, (...args: any[]) => any>();
	let definition: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const notices: { text: string; level: string }[] = [];
	let renders = 0;
	const tui = { mode: "fullscreen", terminal: { write() {} }, invalidate() {}, requestRender() { renders++; }, getActiveSelectionText() { return undefined; } };
	const ctx = { mode: "tui", cwd: "/tmp", ui: {
		setWidget(_name: string, factory?: (tui: unknown) => unknown) { factory?.(tui); },
		notify(text: string, level: string) { notices.push({ text, level }); },
	} };
	const api = {
		on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); },
		registerCommand(_name: string, command: NonNullable<typeof definition>) { definition = command; },
		getCommands: () => [], getSettings: () => ({ terminal: { showImages: true } }),
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
		assert.deepEqual(await definition!.getArgumentCompletions!("images:bg:light"), []);
		assert.deepEqual(await definition!.getArgumentCompletions!("images:height:56"), []);
	} finally { hooks.get("session_shutdown")!(); }
	assert.equal(isPatched(), false);
});

test("extension never registers context/message mutation hooks and skips RPC rendering", async () => {
	const hooks = new Map<string, (...args: any[]) => any>();
	const api = { on: (name: string, fn: (...args: any[]) => any) => { hooks.set(name, fn); }, registerCommand() {} } as unknown as ExtensionAPI;
	extension(api);
	assert.deepEqual([...hooks.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start"]);
	await hooks.get("session_start")!({}, { mode: "rpc" });
	assert.equal(isPatched(), false);
});
