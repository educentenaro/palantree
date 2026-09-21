import type { AnalysisFinding, SourceFileKind, TokenCategory } from "./types.js";
import { normalizeColorValue, normalizeValueForCategory } from "./token-normalizer.js";
import { isNativeFontSize, isNativeShadow, isStructuralColorUtility, namedTailwindColor } from "./shadcn-baseline.js";

export const CLASS_CALLS = new Set(["cn", "clsx", "classnames", "cva"]);
const PREFIX = /^(rounded(?:-[trblse]{1,2})?|border(?:-[xytrblse])?|ring|fill|stroke|bg|text|shadow|p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|w|h|min-w|max-w|min-h|max-h|size)-(.+)$/;
const STRUCTURAL = /^(?:auto|none|full|screen|min|max|fit|inherit|initial|current|transparent|collapse|separate|solid|dashed|dotted|double|hidden|clip|ellipsis|left|right|center|justify|start|end|cover|contain|fixed|local|scroll|repeat.*|no-repeat)$/;

export function classCategory(prefix: string, value: string): TokenCategory {
  if (prefix.startsWith("rounded")) return "radius";
  if (prefix === "shadow") return "shadows";
  if (prefix === "text" && /^(?:length:|[-\d.]|xs$|sm$|base$|lg$|[2-9]?xl$)/.test(value)) return "fontSizes";
  if (/^(bg|text|border.*|ring|fill|stroke)$/.test(prefix)) return "colors";
  return "spacing";
}

export function withOpacity(value: string, modifier?: string): string | null {
  const color = normalizeColorValue(value);
  if (!color || !modifier) return color;
  if (!/^\d+(?:\.\d+)?$/.test(modifier) || Number(modifier) > 100) return null;
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1;
  const byte = Math.round(alpha * Number(modifier) / 100);
  return color.slice(0, 7) + (byte === 255 ? "" : byte.toString(16).padStart(2, "0"));
}

export function inspectClasses(node: any, filePath: string, source: string, sourceKind: SourceFileKind,
  findings: AnalysisFinding[], visited: Set<number>): void {
  if (!node) return;
  const visit = (child: any) => inspectClasses(child, filePath, source, sourceKind, findings, visited);
  if (node.type === "JSXExpressionContainer") return visit(node.expression);
  if (node.type === "ConditionalExpression") { visit(node.consequent); visit(node.alternate); return; }
  if (node.type === "LogicalExpression") { visit(node.left); visit(node.right); return; }
  if (node.type === "ArrayExpression") { node.elements.forEach(visit); return; }
  if (node.type === "ObjectExpression") {
    for (const prop of node.properties) if (prop.type === "ObjectProperty" && !prop.computed) visit(prop.key);
    return;
  }
  if (node.type === "CallExpression" && CLASS_CALLS.has(node.callee.name)) {
    if (node.callee.name === "cva") {
      visit(node.arguments[0]);
      const options = node.arguments[1];
      for (const prop of options?.properties ?? []) {
        const name = prop.key?.name ?? prop.key?.value;
        if (name === "variants") for (const variant of prop.value.properties ?? []) {
          for (const option of variant.value.properties ?? []) visit(option.value);
        }
        if (name === "compoundVariants") for (const entry of prop.value.elements ?? []) {
          for (const field of entry?.properties ?? []) if (["class", "className"].includes(field.key?.name ?? field.key?.value)) visit(field.value);
        }
      }
    } else node.arguments.forEach(visit);
    return;
  }
  if (node.type === "TemplateLiteral") {
    node.quasis.forEach((part: any, index: number) => {
      // Never interpret a class whose value is assembled dynamically.
      let raw = part.value.raw as string;
      let offset = part.start as number;
      if (index > 0) { const leading = raw.match(/^\S*/)?.[0] ?? ""; raw = raw.slice(leading.length); offset += leading.length; }
      if (index < node.expressions.length) raw = raw.replace(/\S*$/, "");
      inspectText(raw, offset);
    });
    node.expressions.forEach(visit);
    return;
  }
  if (node.type === "StringLiteral") inspectText(source.slice(node.start + 1, node.end - 1), node.start + 1);

  function inspectText(text: string, offset: number) {
    if (visited.has(offset)) return;
    visited.add(offset);
    for (const match of text.matchAll(/\S+/g)) {
      const className = match[0];
      let depth = 0, split = -1, slash = -1;
      for (let i = 0; i < className.length; i++) {
        if (className[i] === "[" || className[i] === "(") depth++;
        if (className[i] === "]" || className[i] === ")") depth--;
        if (!depth && className[i] === ":") split = i;
        if (!depth && className[i] === "/") slash = i;
      }
      let base = className.slice(split + 1, slash > split ? slash : undefined);
      const variants = className.slice(0, split + 1) + (base.startsWith("!") ? "!" : "");
      const importantSuffix = base.endsWith("!");
      base = base.replace(/^!|!$/g, "");
      const negative = base.startsWith("-");
      const parsed = base.replace(/^-/, "").match(PREFIX);
      if (!parsed) continue;
      const [, prefix, candidate] = parsed;
      const arbitrary = candidate.startsWith("[") && candidate.endsWith("]");
      let rawValue = arbitrary ? candidate.slice(1, -1).replace(/_/g, " ") : candidate;
      if (/^(?:var\(|--)/.test(rawValue) || (STRUCTURAL.test(rawValue) && !(prefix.startsWith("rounded") && rawValue === "full"))) continue;
      // Numeric border/ring/stroke utilities describe widths, not colors.
      if (/^(border.*|ring|stroke)$/.test(prefix) && /^\d+(?:px|rem|em)?$/.test(rawValue)) continue;
      if (/^(bg|text)$/.test(prefix) && /^(?:gradient-|linear-|radial|conic|size:|position:|url\(|image:)/.test(rawValue)) continue;
      if (prefix === "text" && /^(?:wrap|nowrap|balance|pretty)$/.test(rawValue)) continue;
      if (prefix === "bg" && /^(?:clip-|origin-|blend-)/.test(rawValue)) continue;
      if (!arbitrary && prefix === "shadow" && isNativeShadow(rawValue)) continue;
      const category = prefix === "shadow" && !arbitrary ? "colors" : classCategory(prefix, rawValue);
      if (!arbitrary) {
        if (category === "spacing" || category === "radius" || (category === "fontSizes" && isNativeFontSize(rawValue))) continue;
        if (isStructuralColorUtility(prefix, rawValue)) continue;
      }
      if (arbitrary && category !== "colors" && /^0(?:px|rem|em)?$/.test(rawValue)) continue;
      rawValue = rawValue.replace(/^(?:color|length):/, "");
      if (negative && arbitrary) rawValue = `-${rawValue}`;
      const modifier = slash > split ? className.slice(slash + 1).replace(/!$/, "") : undefined;
      const normalizedValue = arbitrary ? (category === "colors" ? withOpacity(rawValue, modifier) : normalizeValueForCategory(category, rawValue)) : base;
      const position = offset + match.index!;
      const before = source.slice(0, position);
      const line = before.split("\n").length;
      findings.push({ filePath, sourceKind, origin: "tailwind", propertyName: prefix, utilityPrefix: prefix,
        className, variants, modifier, replacementAfter: importantSuffix ? "!" : "", rawValue,
        tailwindColorValue: !arbitrary && category === "colors" ? namedTailwindColor(rawValue, modifier) : undefined,
        normalizedValue: normalizedValue ?? (modifier ? `unresolved:${className}` : rawValue), category, kind: arbitrary ? "literal" : "reference",
        confidence: "high", line, column: position - before.lastIndexOf("\n"), context: source.split(/\r?\n/)[line - 1]?.trim() ?? "" });
    }
  }
}
