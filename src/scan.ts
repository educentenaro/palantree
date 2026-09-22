import { readFile } from "node:fs/promises";
import { loadRawTokens } from "./figma-parser.js";
import { collectSourceFiles } from "./file-scanner.js";
import { analyzeSourceFile } from "./ast-analyzer.js";
import { normalizeTokens } from "./token-normalizer.js";
import { validateFindings } from "./validator.js";
import type { AnalysisFinding, CliConfig } from "./types.js";

export async function scan(config: CliConfig) {
  const rawTokens = await loadRawTokens(config.figmaPath);
  const index = normalizeTokens(rawTokens);
  if (!index.tokens.length) throw new Error(`No supported tokens found in ${config.figmaPath}`);
  const files = await collectSourceFiles(config.srcPaths, config.exclude);
  if (!files.length) throw new Error(`No supported source files found in ${config.srcPaths.join(", ")}`);
  const findings: AnalysisFinding[] = [];
  // Bound memory and file handles even for large repositories.
  for (const file of files) {
    try {
      findings.push(...await analyzeSourceFile(file, await readFile(file, "utf8")));
    } catch (error) {
      throw new Error(`Cannot analyze ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files, results: validateFindings(findings, index) };
}
