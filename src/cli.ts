#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadConfig, type ProjectConfig } from "./config.js";
import { acceptsShadcnAnswer, ensureInitProject, initProject, isShadcnConfigured } from "./init.js";
import { scan } from "./scan.js";
import { formatReport } from "./reporter.js";

const usage = `palantree — React design token linting

Usage:
  palantree init [options]
  palantree scan [options]

Init options:
  --figma, -f <path>       Tokens JSON file or directory (default: tokens.json)
  --src, -s <path>         Source directory or file (default: src)
  --force                  Replace conflicting config and lint:design script
  --yes, -y                Confirm this is a shadcn/ui project without prompting

Scan options:
  --figma, -f <path>       Tokens JSON file or directory (default: tokens.json)
  --src, -s <path>         Source directory or file (default: src)
  --config, -c <path>      JSON config (default: ./design-lint.config.json)
  --format <text|json>     Report format
  --fail-on-warnings       Fail on warnings as well as errors

Global options:
  --help, -h               Show help
  --version, -v            Show version

Exit codes: 0 passed; 1 lint violations; 2 configuration, I/O or parse failure.`;

async function main() {
  try {
    const { values, positionals } = parseArgs({
      options: {
        figma: { type: "string", short: "f" },
        src: { type: "string", short: "s" },
        config: { type: "string", short: "c" },
        format: { type: "string" },
        "fail-on-warnings": { type: "boolean" },
        force: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (values.help || process.argv.length === 2) { console.log(usage); return; }
    if (values.version) {
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      console.log(pkg.version);
      return;
    }
    if (positionals.length !== 1 || !["init", "scan"].includes(positionals[0])) {
      throw new Error(`Unknown command: ${positionals.join(" ") || "(missing)"}. Use "palantree init" or "palantree scan".`);
    }
    for (const key of ["figma", "src", "config"] as const) {
      if (values[key] !== undefined && !values[key]!.trim()) throw new Error(`--${key} requires a non-empty path`);
    }

    if (positionals[0] === "init") {
      if (values.config !== undefined || values.format !== undefined || values["fail-on-warnings"] !== undefined) {
        throw new Error("init only accepts --figma, --src, --force and --yes");
      }
      await ensureInitProject();
      const configured = await isShadcnConfigured();
      let confirmed = configured || values.yes === true;
      if (!confirmed) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error("Cannot confirm shadcn/ui in a non-interactive terminal; rerun palantree init --yes");
        }
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await prompt.question("Este projeto utiliza shadcn/ui? (Y/n) ")).trim().toLowerCase();
        prompt.close();
        confirmed = acceptsShadcnAnswer(answer);
        if (!confirmed) throw new Error("Palantree is exclusive to shadcn/ui projects; initialization cancelled");
      }
      const result = await initProject({ figma: values.figma, src: values.src, force: values.force, shadcnConfirmed: confirmed });
      console.log("Palantree initialized.");
      console.log("Created design-lint.config.json and added the lint:design script.");
      for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
      console.log("Run: npm run lint:design");
      return;
    }

    if (values.force !== undefined || values.yes !== undefined) throw new Error("scan does not accept --force or --yes");
    if (values.format !== undefined && values.format !== "text" && values.format !== "json") throw new Error("--format must be text or json");
    const overrides: ProjectConfig = {};
    if (values.figma !== undefined) overrides.figma = values.figma;
    if (values.src !== undefined) overrides.src = values.src;
    if (values.format !== undefined) overrides.format = values.format;
    if (values["fail-on-warnings"] !== undefined) overrides.failOnWarnings = values["fail-on-warnings"];
    const config = await loadConfig(overrides, values.config);
    const { files, results } = await scan(config);
    const report = formatReport(results, config.basePath, config.failOnWarnings);
    const failed = report.summary.error > 0 || (config.failOnWarnings && report.summary.warning > 0);
    console.log(config.format === "json"
      ? JSON.stringify({ files, results, summary: report.summary, passed: !failed }, null, 2)
      : `Scanned ${files.length} file${files.length === 1 ? "" : "s"}\n\n${report.text}`);
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error(`palantree: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

await main();
