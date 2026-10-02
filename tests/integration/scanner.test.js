import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSourceFiles } from "../../dist/file-scanner.js";
import { analyzeSourceFile } from "../../dist/ast-analyzer.js";

test("scanner excludes whole directories without excluding siblings with the same prefix", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "palantree-scanner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["generated", "generated-other", "node_modules", "dist", ".hidden"]) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, "App.tsx"), "export const x = 1;");
  }
  await writeFile(join(root, "notes.md"), "not source");
  assert.deepEqual(await collectSourceFiles(root, [join(root, "generated")]), [join(root, "generated-other", "App.tsx")]);
});

test("scanner combines multiple roots without returning overlapping files twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "palantree-multiple-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "app"));
  await mkdir(join(root, "components"));
  await writeFile(join(root, "app", "page.tsx"), "export default null;");
  await writeFile(join(root, "components", "button.tsx"), "export const Button = null;");
  assert.deepEqual(await collectSourceFiles([root, join(root, "app"), join(root, "missing")]), [
    join(root, "app", "page.tsx"),
    join(root, "components", "button.tsx"),
  ]);
});

test("scanner applies file and directory exclusions across directory aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "palantree-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physical = join(root, "physical");
  const alias = join(root, "alias");
  await mkdir(join(physical, "generated"), { recursive: true });
  await mkdir(join(physical, "generated-other"));
  for (const file of ["Selected.tsx", "Excluded.tsx", "generated/App.tsx", "generated-other/App.tsx"]) {
    await writeFile(join(physical, file), "export const x = 1;");
  }
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  for (const [source, excluded] of [[alias, physical], [physical, alias]]) {
    assert.deepEqual(await collectSourceFiles(source, [
      join(excluded, "Excluded.tsx"), join(excluded, "generated"), join(excluded, "missing"),
    ]), [join(source, "generated-other", "App.tsx"), join(source, "Selected.tsx")]);
    assert.deepEqual(await collectSourceFiles(join(source, "Excluded.tsx"), [join(excluded, "Excluded.tsx")]), []);
    assert.deepEqual(await collectSourceFiles(source, [excluded]), []);
  }
});

test("CSS parser retains declarations and reports malformed CSS", async () => {
  const findings = await analyzeSourceFile("styles.css", ".button { padding: 12px; color: #13544A; }");
  assert.equal(findings.length, 2);
  await assert.rejects(analyzeSourceFile("broken.css", ".button { color red; }"));
});

test("CSS parser accepts Tailwind v4 directive preludes", async () => {
  const css = `@import "tailwindcss";
@custom-variant dark (&:is(.dark *));
@layer base { body { margin: 12px; } }`;
  const findings = await analyzeSourceFile("styles.css", css);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].propertyName, "margin");
});
