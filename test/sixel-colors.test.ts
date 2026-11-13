import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { getCapabilities, setCapabilities, TuiAltScreen, type Terminal, type TerminalColors, type TerminalColorScheme } from "@earendil-works/pi-tui";
import { resolveSixelBackground, sgrBackground } from "../src/math/sixel-colors.ts";
import { createSixelColorSource, type SixelColorHost } from "../src/sixel-terminal.ts";

const dark = { r: 23, g: 26, b: 33 }, light = { r: 255, g: 255, b: 255 };

test("background SGR handles reset, RGB, indexed colors and skips unrelated color parameters", () => {
	for (const sgr of ["", "0", "49", "1;49", "48;2;1;2;3;0"]) assert.equal(sgrBackground(sgr, dark), undefined);
	for (const sgr of ["38;2;48;49;0", "38:2::48:49:0", "58;2;0;49;48", "38;5;49", "39", "1;2;22", "48;2;300;0;0", "48;2;1", "48:2:1:1:2:3"]) {
		assert.deepEqual(sgrBackground(sgr, dark), dark, sgr);
	}
	for (const sgr of ["48;2;23;26;33", "48:2:23:26:33", "48:2::23:26:33", "48:2:0:23:26:33", "0;48;2;23;26;33;1"]) {
		assert.deepEqual(sgrBackground(sgr), dark, sgr);
	}
	for (let i = 0; i < 8; i++) {
		assert.equal(sgrBackground(String(40 + i)), i);
		assert.equal(sgrBackground(String(100 + i)), i + 8);
	}
	assert.equal(sgrBackground("48;5;232"), 232);
	assert.equal(sgrBackground("48:5:17"), 17);
});

test("default and indexed backgrounds use the reported terminal palette with xterm fallbacks", () => {
	assert.deepEqual(resolveSixelBackground(undefined, {}), { r: 0, g: 0, b: 0 });
	assert.deepEqual(resolveSixelBackground(undefined, { background: dark }), dark);
	assert.deepEqual(resolveSixelBackground(light, { background: dark }), light);
	assert.deepEqual(resolveSixelBackground(1, {}), { r: 128, g: 0, b: 0 });
	assert.deepEqual(resolveSixelBackground(17, {}), { r: 0, g: 0, b: 95 });
	assert.deepEqual(resolveSixelBackground(232, {}), { r: 8, g: 8, b: 8 });
	const palette = Array.from({ length: 16 }, () => dark);
	assert.deepEqual(resolveSixelBackground(1, { palette }), dark);
	assert.deepEqual(resolveSixelBackground(9, { palette }), dark);
});

test("color source handles timeout, late replies, palette changes, superseded queries and teardown", async () => {
	type QueryOptions = Parameters<NonNullable<SixelColorHost["queryTerminalColors"]>>[0];
	const requests: { options: QueryOptions; resolve(colors: TerminalColors): void }[] = [];
	const listeners = new Set<(scheme: TerminalColorScheme) => void>();
	let fallback = dark, paints = 0, removed = 0;
	const source = createSixelColorSource({
		queryTerminalColors(options) { return new Promise((resolve) => requests.push({ options, resolve })); },
		onTerminalColorSchemeChange(listener) {
			listeners.add(listener);
			return () => { removed++; listeners.delete(listener); };
		},
	}, () => fallback, () => { paints++; }, "sixel");
	try {
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.options.timeoutMs, 100);
		assert.deepEqual(source.read().background, dark);
		requests[0]!.resolve({}); // Terminal did not answer before timeout.
		await settle();
		fallback = light; // A Pi theme switch must not leave a stale fallback.
		assert.deepEqual(source.read().background, light);
		assert.equal(paints, 0);
		requests[0]!.options.onLateReply!({ background: dark });
		assert.deepEqual(source.read().background, dark);
		assert.equal(paints, 1);
		requests[0]!.options.onLateReply!({ background: { ...dark }, foreground: light });
		assert.equal(paints, 1, "irrelevant or duplicate replies do not repaint");
		requests[0]!.options.onLateReply!({ background: { r: NaN, g: 0, b: 0 }, palette: [light] });
		assert.deepEqual(source.read().background, dark);
		assert.equal(paints, 1);
		const palette = Array.from({ length: 16 }, () => ({ ...dark }));
		requests[0]!.options.onLateReply!({ palette });
		assert.deepEqual(source.read().palette, palette);
		assert.equal(paints, 2);
		palette[0]!.r = 100;
		assert.deepEqual(source.read().palette![0], dark, "snapshot replies, not mutable host buffers");
		for (const listener of listeners) listener("light");
		assert.equal(requests.length, 2);
		requests[1]!.resolve({ background: light });
		await settle();
		assert.deepEqual(source.read().background, light);
		assert.equal(paints, 3);
		requests[0]!.options.onLateReply!({ background: dark });
		assert.equal(paints, 3, "old query cannot overwrite a newer appearance");
		for (const listener of listeners) listener("dark");
		source.dispose(); source.dispose();
		assert.equal(removed, 1);
		assert.equal(listeners.size, 0);
		requests[2]!.resolve({ background: dark });
		requests[1]!.options.onLateReply!({ background: dark });
		await settle();
		assert.equal(paints, 3, "no repaint from late callbacks after shutdown/reload");
		assert.deepEqual(source.read().background, light);
	} finally { source.dispose(); }
});

test("color probing fails softly and never runs for Kitty/direct/off", async () => {
	const unexpected = () => { throw new Error("not supported"); };
	for (const host of [{}, { queryTerminalColors: unexpected }, { queryTerminalColors: async () => unexpected() }]) {
		const source = createSixelColorSource(host, () => light, () => assert.fail("no color reply"), "sixel");
		await settle();
		assert.deepEqual(source.read().background, light);
		source.dispose();
	}
	for (const mode of ["placeholder", "direct", "off"] as const) {
		const source = createSixelColorSource({
			queryTerminalColors: () => assert.fail("Kitty must not acquire a Sixel color query"),
			onTerminalColorSchemeChange: () => assert.fail("Kitty must not acquire a Sixel listener"),
		}, () => dark, unexpected, mode);
		source.dispose();
	}
});

test("real Pi input parser supplies OSC 11 colors without consuming ordinary input", async () => {
	const caps = getCapabilities();
	setCapabilities({ ...caps, images: null });
	let output = "", input: (data: string) => void = () => {}, paints = 0;
	const ordinary: string[] = [];
	const terminal = {
		columns: 40, rows: 10, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
		write(data) { output += data; }, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	} satisfies Terminal;
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
	const component = { render: () => [], invalidate() {}, handleInput: (s: string) => ordinary.push(s) };
	tui.addChild(component); tui.setFocus(component);
	let stop = () => {};
	try {
		tui.start();
		const source = createSixelColorSource(tui, () => light, () => { paints++; }, "sixel");
		stop = source.dispose;
		assert.ok(output.includes("\x1b]11;?"));
		input("\x1b]11;rgb:1717/1a1a/2121\x1b\\");
		input("\x1b[?1;2c");
		await settle();
		assert.deepEqual(source.read().background, dark);
		assert.equal(paints, 1);
		input("x");
		assert.deepEqual(ordinary, ["x"]);
	} finally { stop(); tui.stop(); setCapabilities(caps); }
});
