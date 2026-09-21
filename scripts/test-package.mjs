import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run with npm run test:package");
const root = await mkdtemp(join(tmpdir(), "palantree-package-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}
function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}
try {
  success(run(process.execPath, [npm, "pack", "--pack-destination", root], { cwd: repo }));
  const archive = (await readdir(root)).find((name) => name.endsWith(".tgz"));
  assert.ok(archive);
  const prefix = join(root, "global");
  success(run(process.execPath, [npm, "install", "--global", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", join(root, archive)], { cwd: root }));
  const installed = process.platform === "win32" ? join(prefix, "node_modules", "palantree") : join(prefix, "lib", "node_modules", "palantree");
  const entries = await readdir(installed);
  assert.ok(entries.includes("dist"));
  assert.ok(entries.every((entry) => ["dist", "package.json", "README.md", "LICENSE", "node_modules"].includes(entry)));
  await assert.rejects(access(join(installed, "node_modules", "typescript")), { code: "ENOENT" });
  const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(pkg.bin, { palantree: "./dist/cli.js" });
  assert.match(await readFile(join(installed, "dist", "cli.js"), "utf8"), /^#!\/usr\/bin\/env node/);
  const project = join(root, "react project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ private: true, dependencies: { react: "^19.0.0" } }));
  await writeFile(join(project, "tokens.json"), JSON.stringify({ spacing: { md: { $type: "dimension", $value: "12px" } } }));
  const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
  // Only the installed command, Node and OS tools: no Bun or repository tools.
  const env = { ...process.env, PATH: [binDir, dirname(process.execPath), process.platform === "win32" ? join(process.env.SystemRoot, "System32") : "/usr/bin:/bin"].join(delimiter) };
  delete env.NODE_PATH;
  const init = process.platform === "win32"
    ? run(process.env.ComSpec || "cmd.exe", ["/d", "/c", "palantree init"], { cwd: project, env })
    : run("palantree", ["init"], { cwd: project, env });
  success(init);
  const config = JSON.parse(await readFile(join(project, "design-lint.config.json"), "utf8"));
  assert.equal(config.failOnWarnings, true);
  assert.equal(JSON.parse(await readFile(join(project, "package.json"), "utf8")).scripts["lint:design"], "palantree scan --fail-on-warnings");
  const app = join(project, "src", "App.tsx");
  await writeFile(app, 'export const App = () => <div style={{ padding: "12px" }} />;');
  const invoke = () => process.platform === "win32"
    ? run(process.env.ComSpec || "cmd.exe", ["/d", "/c", "palantree scan --format json"], { cwd: project, env })
    : run("palantree", ["scan", "--format", "json"], { cwd: project, env });
  const failed = invoke();
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).summary.error, 1);
  await writeFile(app, 'export const App = () => <div style={{ padding: tokens.spacing.md }} />;');
  const passed = success(invoke());
  assert.equal(JSON.parse(passed.stdout).summary.valid, 1);
  console.log("Package verified: npm pack, isolated global install, init, and external React project scans without Bun.");
} finally {
  // Only remove the exact temporary directory allocated above.
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true });
}
