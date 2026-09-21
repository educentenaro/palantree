import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
