import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface InitOptions {
  figma?: string;
  src?: string;
  force?: boolean;
  shadcnConfirmed?: boolean;
}

const CONFIG_FILE = "design-lint.config.json";
const LINT_SCRIPT = "palantree scan --fail-on-warnings";
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git", ".cache", "out"]);

export async function initProject(options: InitOptions, cwd = process.cwd()) {
  const packagePath = resolve(cwd, "package.json");
  const configPath = resolve(cwd, CONFIG_FILE);
  const packageText = await readRequiredFile(packagePath, "Run palantree init from a project containing package.json");
  const packageJson = parseObject(packageText, packagePath);
  const existingConfig = await readOptionalFile(configPath);
  const alreadyConfigured = existingConfig !== undefined && readPreset(existingConfig) === "shadcn";
  if (!options.shadcnConfirmed && !alreadyConfigured) {
    throw new Error("Palantree is exclusive to shadcn/ui projects; confirm with palantree init --yes");
  }
  const scripts = packageJson.scripts === undefined ? {} : parseObjectValue(packageJson.scripts, '"scripts" in package.json must be an object');
  const figma = options.figma ?? await discoverTokenPath(cwd) ?? "./tokens.json";
  const src = options.src ?? "./src";
  const config = { preset: "shadcn", figma, src, exclude: [], format: "text", failOnWarnings: true };
  const configText = `${JSON.stringify(config, null, 2)}\n`;

  if (existingConfig !== undefined && !options.force && !jsonEquals(existingConfig, configText) && !legacyConfigEquals(existingConfig, config)) {
    throw new Error(`${CONFIG_FILE} already exists with different settings; use --force to replace it`);
  }
  const existingScript = scripts["lint:design"];
  if (existingScript !== undefined && existingScript !== LINT_SCRIPT && !options.force) {
    throw new Error('package.json already has a different "lint:design" script; use --force to replace it');
  }

  scripts["lint:design"] = LINT_SCRIPT;
  packageJson.scripts = scripts;
  const indent = detectIndent(packageText);
  const newline = packageText.includes("\r\n") ? "\r\n" : "\n";
  const nextPackageText = `${JSON.stringify(packageJson, null, indent)}\n`.replaceAll("\n", newline);

  if (existingConfig === undefined || options.force || !jsonEquals(existingConfig, configText)) {
    await writeFile(configPath, configText, "utf8");
  }
  if (packageText !== nextPackageText) await writeFile(packagePath, nextPackageText, "utf8");

  const warnings: string[] = [];
  if (!await exists(resolve(cwd, figma))) warnings.push(`Token path not found yet: ${figma}`);
  if (!await exists(resolve(cwd, src))) warnings.push(`Source path not found yet: ${src}`);
  return { configPath, packagePath, warnings };
}

export async function isShadcnConfigured(cwd = process.cwd()): Promise<boolean> {
  const text = await readOptionalFile(resolve(cwd, CONFIG_FILE));
  return text !== undefined && readPreset(text) === "shadcn";
}

export async function ensureInitProject(cwd = process.cwd()): Promise<void> {
  await readRequiredFile(resolve(cwd, "package.json"), "Run palantree init from a project containing package.json");
}

export function acceptsShadcnAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || ["y", "yes", "s", "sim"].includes(normalized);
}

function readPreset(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")).preset; } catch { return undefined; }
}

function legacyConfigEquals(text: string, config: Record<string, unknown>): boolean {
  try {
    const existing = JSON.parse(text.replace(/^\uFEFF/, ""));
    return existing && typeof existing === "object" && !("preset" in existing)
      && JSON.stringify({ preset: "shadcn", ...existing }) === JSON.stringify(config);
  } catch { return false; }
}

async function readRequiredFile(path: string, missingMessage: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(missingMessage);
    throw error;
  }
}

async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseObject(text: string, path: string): Record<string, any> {
  try {
    return parseObjectValue(JSON.parse(text.replace(/^\uFEFF/, "")), `${path} must contain a JSON object`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Cannot parse ${path}: ${error.message}`);
    throw error;
  }
}

function parseObjectValue(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, any>;
}

function jsonEquals(left: string, right: string) {
  try {
    return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
  } catch {
    return false;
  }
}

function detectIndent(text: string): string | number {
  const match = text.match(/^([\t ]+)"/m);
  return match?.[1] ?? 2;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverTokenPath(cwd: string): Promise<string | undefined> {
  for (const candidate of ["tokens.json", "tokens", "design-tokens"]) {
    const candidatePath = resolve(cwd, candidate);
    if (await exists(candidatePath)) return toConfigPath(cwd, candidatePath);
  }

  const tokenFiles = await collectTokenFiles(cwd);
  if (tokenFiles.length === 1) return toConfigPath(cwd, tokenFiles[0]);
  if (tokenFiles.length > 1) return toConfigPath(cwd, commonDirectory(tokenFiles));
  return undefined;
}

async function collectTokenFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORED_DIRECTORIES.has(entry.name)) files.push(...await collectTokenFiles(path));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tokens.json")) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function commonDirectory(files: string[]) {
  const directories = files.map((file) => file.split(/[\\/]/).slice(0, -1));
  const common: string[] = [];
  for (let index = 0; index < directories[0].length; index += 1) {
    const segment = directories[0][index];
    if (!directories.every((parts) => parts[index]?.toLowerCase() === segment.toLowerCase())) break;
    common.push(segment);
  }
  return common.join(sep);
}

function toConfigPath(cwd: string, path: string) {
  const value = relative(cwd, path).split(sep).join("/");
  return value === "" ? "." : value.startsWith(".") ? value : `./${value}`;
}
