import { extname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { SUPPORTED_SOURCE_EXTENSIONS, type SupportedSourceExtension } from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".bun",
  ".cache",
  "out",
]);

export async function collectSourceFiles(rootPaths: string | string[], exclude: string[] = []): Promise<string[]> {
  const roots = Array.isArray(rootPaths) ? rootPaths : [rootPaths];
  const excludedPaths = exclude.map((entry) => resolve(entry));
  const isExcluded = (path: string) => excludedPaths.some((entry) => {
    const rel = relative(entry, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  const files = new Set<string>();
  for (const rootPath of roots) {
    const resolvedPath = resolve(rootPath);
    if (isExcluded(resolvedPath)) continue;
    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    if (stats.isFile()) {
      if (isSupportedSourceFile(resolvedPath)) files.add(resolvedPath);
      continue;
    }

    for (const file of await walkDirectory(resolvedPath, isExcluded)) files.add(file);
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(directoryPath: string, isExcluded: (path: string) => boolean): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (isExcluded(join(directoryPath, entry.name))) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }

      files.push(...(await walkDirectory(join(directoryPath, entry.name), isExcluded)));
      continue;
    }

    if (entry.isFile()) {
      const filePath = join(directoryPath, entry.name);

      if (isSupportedSourceFile(filePath)) {
        files.push(filePath);
      }
    }
  }

  return files;
}

function isSupportedSourceFile(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase();
  return (SUPPORTED_SOURCE_EXTENSIONS as readonly string[]).includes(extension as SupportedSourceExtension);
}
