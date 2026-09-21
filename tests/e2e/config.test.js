import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "palantree-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tokens.json"), JSON.stringify({ spacing: { md: { $type: "dimension", $value: "12px" } } }));
  await writeFile(join(root, "src", "App.tsx"), 'export const App = () => <div style={{ padding: "12px" }} />;');
  return {
    root,
    run: (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" }),
    config: (value) => writeFile(join(root, "design-lint.config.json"), JSON.stringify(value)),
  };
}

test("scan defaults and JSON report", async (t) => {
  const f = await fixture(t);
  const result = f.run("scan", "--format=json");
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.error, 1);
  assert.equal(report.passed, false);
  assert.equal(report.files.length, 1);
  assert.equal(f.run("scan", "-f", "tokens.json", "-s", "src").status, 1);
});

test("config exclusions and CLI overrides", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "src", "Clean.jsx"), 'export const Clean = () => <div />;');
  await f.config({ exclude: ["src/App.tsx"], format: "json" });
  const result = f.run("scan");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files.length, 1);
  assert.match(f.run("scan", "--format=text").stdout, /Result: passed/);
  assert.equal(f.run("scan", "--src=src/App.tsx").status, 2);
});

test("explicit config paths resolve from config directory, CLI paths from cwd", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "settings"));
  await writeFile(join(f.root, "settings", "lint.json"), JSON.stringify({ figma: "../tokens.json", src: "../src" }));
  assert.equal(f.run("scan", "-c", "settings/lint.json").status, 1);
  assert.equal(f.run("scan", "-c", "settings/lint.json", "-s", "src").status, 1);
});

test("invalid arguments and configuration exit 2 without report", async (t) => {
  const f = await fixture(t);
  for (const args of [["scna"], ["scan", "--unknown"], ["scan", "--src"], ["scan", "--src="], ["scan", "--format=xml"], ["scan", "-c", "missing.json"]]) {
    const result = f.run(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /palantree:/);
    assert.equal(result.stdout, "");
  }
  for (const config of [null, [], { typo: true }, { src: 1 }, { exclude: ["**/*.tsx"] }, { failOnWarnings: "yes" }]) {
    await f.config(config);
    assert.equal(f.run("scan").status, 2, JSON.stringify(config));
  }
});

test("scan requires the explicit command", async (t) => {
  const f = await fixture(t);
  const result = f.run("-f", "tokens.json", "-s", "src");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use "palantree init" or "palantree scan"/);
});

test("missing tokens, malformed tokens, empty sources and invalid TSX fail clearly", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("scan", "--figma=missing.json").status, 2);
  await writeFile(join(f.root, "src", "App.tsx"), "export const = <");
  const syntax = f.run("scan");
  assert.equal(syntax.status, 2);
  assert.match(syntax.stderr, /App.tsx/);
  await mkdir(join(f.root, "empty"));
  assert.equal(f.run("scan", "--src=empty").status, 2);
  for (const text of ["{broken", "null", "{}"] ) {
    await writeFile(join(f.root, "tokens.json"), text);
    assert.equal(f.run("scan").status, 2);
  }
});

test("warnings can fail CI and help/version need no project", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "src", "App.tsx"), 'export const App = () => <div style={{ fontSize: "19px" }} />;');
  const normal = f.run("scan", "--format=json");
  assert.equal(normal.status, 0);
  assert.equal(JSON.parse(normal.stdout).summary.warning, 1);
  assert.equal(f.run("scan", "--fail-on-warnings").status, 1);
  await f.config({ failOnWarnings: true });
  assert.match(f.run("scan").stdout, /Result: failed/);
  assert.equal(f.run("--help").status, 0);
  assert.match(f.run("--version").stdout, /^\d+\.\d+\.\d+/);
});
