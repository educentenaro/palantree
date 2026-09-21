import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRawTokens } from "../../dist/figma-parser.js";
import { collectSourceFiles } from "../../dist/file-scanner.js";
import { analyzeSourceFile } from "../../dist/ast-analyzer.js";
import { normalizeTokens } from "../../dist/token-normalizer.js";
import { formatReport } from "../../dist/reporter.js";
import { validateFindings } from "../../dist/validator.js";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
  tempDirs = [];
});

test("loads tokens, scans sources, and produces a mixed report", async () => {
  const root = await mkdtemp(join(tmpdir(), "palantree-pipeline-"));
  tempDirs.push(root);

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
        radius: {
          rounded: {
            md: {
              $type: "dimension",
              $value: "6px",
            },
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(tokensDir, "Dark.tokens.json"),
    JSON.stringify(
      {
        $extensions: {
          "com.figma.modeName": "Dark",
        },
        color: {
          background: {
            100: {
              $type: "color",
              $value: "#111111",
            },
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(srcDir, "Button.tsx"),
    [
      'export function Button() {',
      '  return <button style={{ color: "#111111", padding: "12px" }} />;',
      '}',
      '',
      'export const themed = {',
      '  color: theme.colors.background[100],',
      '};',
      '',
    ].join("\n"),
  );

  const rawTokens = await loadRawTokens(tokensDir);
  const tokenIndex = normalizeTokens(rawTokens);
  const sourceFiles = await collectSourceFiles(srcDir);
  const findings = (await Promise.all(sourceFiles.map(async (filePath) => analyzeSourceFile(filePath, await readFile(filePath, "utf8"))))).flat();
  const validationResults = validateFindings(findings, tokenIndex);
  const report = formatReport(validationResults, srcDir);

  assert.equal((rawTokens).length, 3);
  assert.equal((sourceFiles).length, 1);
  assert.equal(report.summary.error, 2);
  assert.equal(report.summary.warning, 0);
  assert.equal(report.summary.valid, 1);
  assert.ok((report.text).includes('Hardcoded color "#111111"'));
  assert.ok((report.text).includes('Hardcoded spacing "12px"'));
  assert.ok((report.text).includes('1 token-backed usages accepted'));
  assert.equal(validationResults.some((result) => result.severity === "valid" && result.message === "Uses token reference theme.colors.background.100"), true);
});
