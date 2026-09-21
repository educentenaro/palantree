import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

async function createFixture(hardcoded) {
  const root = await mkdtemp(join(tmpdir(), "palantree-e2e-"));
  const tokensDir = join(root, "tokens");
  const srcDir = join(root, "src");

  await mkdir(tokensDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });

  await writeFile(
    join(tokensDir, "Default.tokens.json"),
    JSON.stringify(
      {
        spacing: {
          md: {
            $type: "dimension",
            $value: "12px",
          },
        },
        color: {
          brand: {
            500: {
              $type: "color",
              $value: "#13544A",
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const componentLines = hardcoded
    ? [
        'export function Button() {',
        '  return <button style={{ color: "#13544A", padding: "12px" }} />;',
        '}',
        '',
      ]
    : [
        'export function Button() {',
        '  return <button style={{ color: theme.colors.brand[500], padding: tokens.spacing.md }} />;',
        '}',
        '',
      ];

  await writeFile(join(srcDir, "Button.tsx"), componentLines.join("\n"));

  return { root, tokensDir, srcDir };
}

test("CLI reports violations and exits with a failure code", async () => {
  const fixture = await createFixture(true);
  try {
    const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    const result = spawnSync(process.execPath, [cliPath, "scan", "--figma", fixture.tokensDir, "--src", fixture.srcDir], { encoding: "utf8" });

    const stdout = result.stdout;
    const stderr = result.stderr;

    assert.equal(result.status, 1);
    assert.ok((stdout).includes('Hardcoded color "#13544A"'));
    assert.ok((stdout).includes('Hardcoded spacing "12px"'));
    assert.ok((stdout).includes("Result: failed"));
    assert.equal(stderr, "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI passes when code uses only token references", async () => {
  const fixture = await createFixture(false);
  try {
    const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
    const result = spawnSync(process.execPath, [cliPath, "scan", "--figma", fixture.tokensDir, "--src", fixture.srcDir], { encoding: "utf8" });

    const stdout = result.stdout;

    assert.equal(result.status, 0);
    assert.ok((stdout).includes("All tokens correctly used"));
    assert.ok((stdout).includes("Result: passed"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
