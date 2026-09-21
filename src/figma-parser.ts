import { extname, join, resolve } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import type { RawToken } from "./types.js";

const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git", ".cache", "out"]);

export async function loadRawTokens(inputPath: string): Promise<RawToken[]> {
  const resolvedPath = resolve(inputPath);
  const stats = await stat(resolvedPath);
  const discoveredFiles = stats.isDirectory() ? await collectJsonFiles(resolvedPath) : [resolvedPath];
  const tokenNamedFiles = discoveredFiles.filter((path) => path.toLowerCase().endsWith(".tokens.json"));
  const inputFiles = tokenNamedFiles.length ? tokenNamedFiles : discoveredFiles;

  const rawTokens: RawToken[] = [];

  for (const filePath of inputFiles) {
    const fileText = await readFile(filePath, "utf8");
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(fileText.replace(/^\uFEFF/, ""));
      if (!isRecord(value)) throw new Error("Expected a JSON object");
      parsed = value;
    } catch (error) {
      throw new Error(`Invalid token file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const modeName = extractModeName(parsed);
    collectTokensFromTree(parsed, [], filePath, modeName, rawTokens);
  }

  rawTokens.sort((left, right) => {
    const fileCompare = left.sourceFile.localeCompare(right.sourceFile);
    if (fileCompare !== 0) {
      return fileCompare;
    }

    return left.pathSegments.join(".").localeCompare(right.pathSegments.join("."));
  });

  return rawTokens;
}

async function collectJsonFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await collectJsonFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && extname(entry.name).toLowerCase() === ".json") {
      files.push(entryPath);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function extractModeName(data: Record<string, unknown>): string | undefined {
  const extensions = data.$extensions as Record<string, unknown> | undefined;
  const modeName = extensions?.["com.figma.modeName"];

  return typeof modeName === "string" ? modeName : undefined;
}

function collectTokensFromTree(
  node: unknown,
  pathSegments: string[],
  sourceFile: string,
  modeName: string | undefined,
  output: RawToken[],
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }

  const tokenLeaf = node as Record<string, unknown> & {
    $type?: string;
    $value?: unknown;
    $extensions?: Record<string, unknown>;
  };

  if (isTokenLeaf(tokenLeaf)) {
    output.push({
      sourceFile,
      modeName,
      pathSegments,
      tokenName: pathSegments.join("."),
      type: String(tokenLeaf.$type),
      rawValue: tokenLeaf.$value,
      extensions: isRecord(tokenLeaf.$extensions) ? tokenLeaf.$extensions : undefined,
    });
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$") || key === "description") {
      continue;
    }

    collectTokensFromTree(value, [...pathSegments, key], sourceFile, modeName, output);
  }
}

function isTokenLeaf(node: Record<string, unknown>): node is Record<string, unknown> & {
  $type: string;
  $value: unknown;
  $extensions?: Record<string, unknown>;
} {
  return typeof node.$type === "string" && "$value" in node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
