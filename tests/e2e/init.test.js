import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acceptsShadcnAnswer, initProject } from "../../dist/init.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "palantree-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tokens.json"), "{}");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "landing", private: true, scripts: { test: "node --test" } }, null, 2) + "\n");
  return { root, run: (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" }) };
}

test("init creates config and preserves package.json scripts", async (t) => {
  const f = await fixture(t);
  const result = f.run("init", "--yes");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Palantree initialized/);
  const config = JSON.parse(await readFile(join(f.root, "design-lint.config.json"), "utf8"));
  assert.deepEqual(config, { preset: "shadcn", figma: "./tokens.json", src: "./src", exclude: [], format: "text", failOnWarnings: true });
  const pkg = JSON.parse(await readFile(join(f.root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts["lint:design"], "palantree scan --fail-on-warnings");
  assert.equal(f.run("init").status, 0);
});

test("init protects conflicts and supports explicit force", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "design-lint.config.json"), JSON.stringify({ src: "app" }));
  const blocked = f.run("init", "--src", "app", "--yes");
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /use --force/);
  const forced = f.run("init", "--src", "app", "--figma", "design/tokens.json", "--force", "--yes");
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stderr, /Token path not found yet/);
  assert.match(forced.stderr, /Source path not found yet/);
  const config = JSON.parse(await readFile(join(f.root, "design-lint.config.json"), "utf8"));
  assert.equal(config.src, "app");
  assert.equal(config.figma, "design/tokens.json");
});

test("init discovers a nested .tokens.json file", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "tokens.json"));
  await writeFile(join(f.root, "src", "Default.tokens.json"), JSON.stringify({ spacing: { md: { $type: "dimension", $value: "12px" } } }));
  const result = f.run("init", "--yes");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Token path not found/);
  const config = JSON.parse(await readFile(join(f.root, "design-lint.config.json"), "utf8"));
  assert.equal(config.figma, "./src/Default.tokens.json");
});

test("init discovers app and components in shadcn projects without src", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "src"), { recursive: true });
  await mkdir(join(f.root, "app"));
  await mkdir(join(f.root, "components"));
  await writeFile(join(f.root, "app", "page.tsx"), "export default function Page() { return null; }");
  await writeFile(join(f.root, "components", "button.tsx"), "export const Button = () => null;");
  const result = f.run("init", "--yes");
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(join(f.root, "design-lint.config.json"), "utf8"));
  assert.deepEqual(config.src, ["./app", "./components"]);
  assert.doesNotMatch(result.stderr, /Source path not found/);
});

test("init safely discovers non-standard source directories", async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, "src"), { recursive: true });
  await mkdir(join(f.root, "features"));
  await mkdir(join(f.root, "tests"));
  await writeFile(join(f.root, "features", "home.jsx"), "export const Home = () => null;");
  await writeFile(join(f.root, "tests", "home.test.js"), "throw new Error('must not be scanned');");
  const result = f.run("init", "--yes");
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(join(f.root, "design-lint.config.json"), "utf8"));
  assert.equal(config.src, "./features");
});

test("init requires package.json and rejects scan-only options", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "palantree-init-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = spawnSync(process.execPath, [cli, "init", "--yes"], { cwd: root, encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /containing package.json/);
  const f = await fixture(t);
  assert.equal(f.run("init", "--format", "json", "--yes").status, 2);
});

test("init requires shadcn confirmation outside a TTY and migrates legacy config", async (t) => {
  const f = await fixture(t);
  const unconfirmed = f.run("init");
  assert.equal(unconfirmed.status, 2);
  assert.match(unconfirmed.stderr, /non-interactive.*--yes/i);
  assert.equal(acceptsShadcnAnswer("sim"), true);
  assert.equal(acceptsShadcnAnswer("n"), false);

  await writeFile(join(f.root, "design-lint.config.json"), JSON.stringify({ figma: "./tokens.json", src: "./src", exclude: [], format: "text", failOnWarnings: true }, null, 2));
  const migrated = f.run("init", "--yes");
  assert.equal(migrated.status, 0, migrated.stderr);
  const config = JSON.parse(await readFile(join(f.root, "design-lint.config.json"), "utf8"));
  assert.equal(config.preset, "shadcn");
  assert.equal(f.run("init").status, 0);
});

test("a negative shadcn confirmation aborts before writing project files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(initProject({ shadcnConfirmed: false }, f.root), /exclusive to shadcn\/ui/);
  await assert.rejects(readFile(join(f.root, "design-lint.config.json")), { code: "ENOENT" });
  const pkg = JSON.parse(await readFile(join(f.root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["lint:design"], undefined);
});
