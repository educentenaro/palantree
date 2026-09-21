import type { AnalysisFinding, NormalizedToken, TokenCategory } from "./types.js";
import { normalizeColorValue } from "./token-normalizer.js";

export const SHADCN_COLOR_NAMES = new Set([
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
  "accent", "accent-foreground", "destructive", "destructive-foreground", "border", "input", "ring",
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "sidebar", "sidebar-foreground",
  "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground",
  "sidebar-border", "sidebar-ring",
]);

const NATIVE_FONT_SIZES = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const NATIVE_SHADOWS = new Set(["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "none"]);
const NATIVE_FONT_REM = new Set([0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.875, 2.25, 3, 3.75, 4.5, 6, 8]);
const NATIVE_RADIUS_REM = new Set([0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3]);

export function isNativeFontSize(value: string): boolean {
  return NATIVE_FONT_SIZES.has(value);
}

export function isNativeShadow(value: string): boolean {
  return NATIVE_SHADOWS.has(value);
}

export function isStructuralColorUtility(prefix: string, value: string): boolean {
  if (prefix.startsWith("border")) return /^(?:[xytrblse]|0|2|4|8|solid|dashed|dotted|double|hidden|none)$/.test(value);
  if (prefix === "ring") return /^(?:0|1|2|4|8|inset|offset(?:-.+)?)$/.test(value);
  if (prefix === "stroke") return /^\d+(?:\.\d+)?$/.test(value);
  return false;
}

export function namedTailwindColor(value: string, modifier?: string): string | undefined {
  const color = value === "white" ? "#ffffff" : value === "black" ? "#000000" : undefined;
  if (!color) return undefined;
  if (!modifier) return color;
  if (!/^\d+(?:\.\d+)?$/.test(modifier) || Number(modifier) > 100) return undefined;
  const alpha = Math.round(Number(modifier) * 2.55).toString(16).padStart(2, "0");
  return normalizeColorValue(`${color}${alpha}`) ?? undefined;
}

export function isSemanticToken(token: NormalizedToken): boolean {
  return token.pathSegments[0]?.toLowerCase() === "tokens" && token.pathSegments[1]?.toLowerCase() === "default";
}

export function isNativeCssValue(category: TokenCategory, normalized: string): boolean {
  const numeric = Number.parseFloat(normalized);
  if (!Number.isFinite(numeric)) return false;
  if (category === "spacing") {
    if (normalized.endsWith("rem")) return Number.isInteger(numeric * 4);
    if (!/[a-z%]/i.test(normalized)) return Number.isInteger(numeric / 4);
  }
  if (category === "fontSizes") return normalized.endsWith("rem") && NATIVE_FONT_REM.has(numeric);
  if (category === "radius") {
    return (normalized.endsWith("rem") && NATIVE_RADIUS_REM.has(numeric)) || normalized === "9999";
  }
  return false;
}

export function semanticUtilityName(token: NormalizedToken, prefix: string): string | undefined {
  if (!isSemanticToken(token)) return undefined;
  const name = token.pathSegments.at(-1)!;
  if (name.startsWith(`${prefix}-`)) return name;
  if (token.category === "spacing") return `${prefix}-${name}`;
  if (token.category === "radius" && name.startsWith("rounded-")) return `${prefix}-${name.slice(8)}`;
  if ((prefix === "fill" || prefix === "stroke") && token.pathSegments.slice(0, -1).some(part => part.toLowerCase() === prefix)) return `${prefix}-${name}`;
  return undefined;
}

export function isBuiltInSemanticClass(finding: AnalysisFinding): boolean {
  const base = finding.normalizedValue.replace(/^-/, "");
  const prefix = finding.utilityPrefix ?? "";
  const value = base.startsWith(`${prefix}-`) ? base.slice(prefix.length + 1) : base;
  return SHADCN_COLOR_NAMES.has(value);
}

export function themePrimitiveName(variable: string): string {
  const name = variable.replace(/^--/, "");
  return name === "sidebar" ? "sidebar-background" : name;
}
