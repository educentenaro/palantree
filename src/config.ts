import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CliConfig } from "./types.js";

export interface ProjectConfig {
  preset?: "shadcn";
  figma?: string;
  src?: string;
  exclude?: string[];
  format?: "text" | "json";
  failOnWarnings?: boolean;
}

export async function loadConfig(overrides: ProjectConfig, configPath?: string, cwd = process.cwd()) {
  const path = resolve(cwd, configPath ?? "design-lint.config.json");
  let saved: ProjectConfig = {};
  let found = false;
  try {
    const text = await readFile(path, "utf8");
    found = true;
    saved = validateConfig(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch (error) {
    if (configPath || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot load config ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const base = found ? dirname(path) : cwd;
  const merged = { ...saved, ...overrides };
  const config: CliConfig = {
    preset: "shadcn",
    figmaPath: resolve(overrides.figma !== undefined ? cwd : base, merged.figma ?? "tokens.json"),
    srcPath: resolve(overrides.src !== undefined ? cwd : base, merged.src ?? "src"),
    exclude: (merged.exclude ?? []).map((entry) => resolve(overrides.exclude !== undefined ? cwd : base, entry)),
  };
  return { ...config, basePath: base, format: merged.format ?? "text", failOnWarnings: merged.failOnWarnings ?? false };
}

function validateConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!["preset", "figma", "src", "exclude", "format", "failOnWarnings"].includes(key)) throw new Error(`Unknown option "${key}"`);
  }
  for (const key of ["figma", "src"]) {
    if (key in config && (typeof config[key] !== "string" || !(config[key] as string).trim())) throw new Error(`"${key}" must be a non-empty path`);
  }
  if ("exclude" in config && (!Array.isArray(config.exclude) || config.exclude.some((path) => typeof path !== "string" || !path.trim() || /[*?]/.test(path)))) {
    throw new Error('"exclude" must contain file or directory paths (globs are not supported)');
  }
  if ("format" in config && config.format !== "text" && config.format !== "json") throw new Error('"format" must be text or json');
  if ("failOnWarnings" in config && typeof config.failOnWarnings !== "boolean") throw new Error('"failOnWarnings" must be boolean');
  if ("preset" in config && config.preset !== "shadcn") throw new Error('"preset" must be "shadcn"');
  return config as ProjectConfig;
}
