import { extname } from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as csstree from "css-tree";
import { CLASS_CALLS, inspectClasses } from "./tailwind-analyzer.js";
import type { AnalysisFinding, ConfidenceLevel, SourceFileKind, TokenCategory } from "./types.js";
import {
  normalizeColorValue,
  normalizeValueForCategory,
} from "./token-normalizer.js";
import { SHADCN_COLOR_NAMES, themePrimitiveName } from "./shadcn-baseline.js";

const STYLE_ATTRIBUTE_NAMES = new Set(["style", "sx", "css"]);
// Babel traverse is CommonJS; native Node ESM exposes its exports object.
const traverse = typeof traverseModule === "function" ? traverseModule : traverseModule.default;
const STYLE_IDENTIFIER_NAMES = /(style|styles|sx|css|theme|tokens)/i;
const STYLE_FACTORY_CALLS = new Set(["css", "createStyles", "makeStyles", "styled"]);
const SAFE_LITERAL_VALUES = new Set([
  "auto",
  "none",
  "inherit",
  "initial",
  "unset",
  "revert",
  "currentcolor",
  "transparent",
  "normal",
  "bold",
  "bolder",
  "lighter",
  "solid",
  "dashed",
  "dotted",
]);

export async function analyzeSourceFile(filePath: string, sourceText: string): Promise<AnalysisFinding[]> {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".css") {
    return analyzeCssSource(filePath, sourceText);
  }

  return analyzeScriptSource(filePath, sourceText);
}

function analyzeScriptSource(filePath: string, sourceText: string): AnalysisFinding[] {
  const sourceKind = getSourceKind(filePath);
  const findings: AnalysisFinding[] = [];
  const visitedObjectExpressions = new Set<string>();
  const visitedClasses = new Set<number>();
  const ast = parse(sourceText, {
    sourceType: "unambiguous",
    errorRecovery: false,
    plugins: ["jsx", "typescript", "classProperties", "classPrivateProperties", "classPrivateMethods", "decorators-legacy", "objectRestSpread", "optionalChaining", "nullishCoalescingOperator"],
  });

  traverse(ast as never, {
    JSXAttribute(path: any) {
      const attributeName = getJSXAttributeName(path.node.name);
      if (attributeName === "className" || attributeName === "class") {
        inspectClasses(path.node.value, filePath, sourceText, sourceKind, findings, visitedClasses);
        return;
      }
      if (!attributeName || !STYLE_ATTRIBUTE_NAMES.has(attributeName)) {
        return;
      }

      const value = path.node.value;
      if (value?.type !== "JSXExpressionContainer" || value.expression.type !== "ObjectExpression") {
        return;
      }

      inspectObjectExpression(value.expression, filePath, sourceText, sourceKind, findings, visitedObjectExpressions, "jsx-style", 0);
    },
    VariableDeclarator(path: any) {
      if (path.node.id.type !== "Identifier" || !path.node.init || path.node.init.type !== "ObjectExpression") {
        return;
      }

      if (!STYLE_IDENTIFIER_NAMES.test(path.node.id.name) && !containsStyleLikeProperty(path.node.init)) {
        return;
      }

      inspectObjectExpression(path.node.init, filePath, sourceText, sourceKind, findings, visitedObjectExpressions, "variable", 0);
    },
    CallExpression(path: any) {
      const calleeName = getCalleeName(path.node.callee);
      if (calleeName && CLASS_CALLS.has(calleeName)) {
        inspectClasses(path.node, filePath, sourceText, sourceKind, findings, visitedClasses);
        return;
      }
      if (!calleeName || !STYLE_FACTORY_CALLS.has(calleeName)) {
        return;
      }

      const firstArgument = path.node.arguments[0];
      if (!firstArgument || firstArgument.type !== "ObjectExpression") {
        return;
      }

      inspectObjectExpression(firstArgument, filePath, sourceText, sourceKind, findings, visitedObjectExpressions, "call", 0);
    },
  });

  return findings;
}

function analyzeCssSource(filePath: string, sourceText: string): AnalysisFinding[] {
  const sourceKind: SourceFileKind = "css";
  const findings: AnalysisFinding[] = [];
  const ast = csstree.parse(sourceText, {
    positions: true,
    // Tailwind directives such as @custom-variant use non-standard preludes.
    // Keep those preludes raw while still parsing and validating declarations.
    parseAtrulePrelude: false,
    onParseError(error: Error) { throw error; },
  });

  csstree.walk(ast, function(this: any, node: any) {
    if (node.type !== "Declaration") {
      return;
    }

    const propertyName = String(node.property);
    const rawValue = csstree.generate(node.value).trim();

    if (propertyName.startsWith("--")) {
      const themeName = themePrimitiveName(propertyName);
      const selector = this.rule?.prelude ? csstree.generate(this.rule.prelude) : "";
      const themeMode = /\.dark\b/.test(selector) ? "Dark" : /:root\b/.test(selector) ? "Light" : undefined;
      const normalizedValue = normalizeColorValue(rawValue);
      if (themeMode && SHADCN_COLOR_NAMES.has(propertyName.slice(2)) && normalizedValue) {
        const loc = node.value.loc?.start ?? node.loc?.start;
        if (loc) findings.push(createFinding({
          filePath, sourceKind, origin: "css", propertyName, rawValue, normalizedValue,
          category: "colors", kind: "theme", confidence: "high", themeMode,
          themeTokenName: themeName, line: loc.line, column: loc.column,
          context: getLineText(sourceText, loc.line),
        }));
      }
      return;
    }

    if (!rawValue || isSafeLiteral(rawValue)) {
      return;
    }

    const category = inferCategoryFromProperty(propertyName, rawValue);
    if (category === "unknown") {
      return;
    }

    const literals: any[] = [];
    if (category === "shadows") {
      if (/var\(/i.test(rawValue)) return;
      literals.push(node.value);
    } else {
      csstree.walk(node.value, function(this: any, child: any) {
        if (child.type === "Function" && /^(var|url)$/i.test(child.name)) return this.skip;
        if (category === "colors" && (child.type === "Hash" || isColorFunction(child))) {
          literals.push(child);
          return this.skip;
        }
        if (category !== "colors" && (child.type === "Dimension" || child.type === "Number") && Number(child.value) !== 0) literals.push(child);
      });
    }
    for (const literal of literals) {
      const loc = literal.loc?.start ?? node.loc?.start;
      if (!loc) continue;
      const literalText = csstree.generate(literal);
      const start = node.value.loc?.start.offset;
      const end = node.value.loc?.end.offset;
      findings.push(createFinding({
      filePath,
      sourceKind,
      origin: "css",
      replacementBefore: `${propertyName}: ${sourceText.slice(start, literal.loc?.start.offset)}`,
      replacementAfter: sourceText.slice(literal.loc?.end.offset, end).trimEnd() + (node.important ? " !important" : ""),
      propertyName,
      rawValue: literalText,
      category,
      kind: "literal",
      confidence: "medium",
      line: loc.line,
      column: loc.column,
      normalizedValue: normalizeValueForCategory(category, literalText) ?? literalText.trim(),
      referencePath: undefined,
      referenceText: undefined,
      context: getLineText(sourceText, loc.line),
      }));
    }
  });

  return findings;
}

function inspectObjectExpression(
  objectExpression: any,
  filePath: string,
  sourceText: string,
  sourceKind: SourceFileKind,
  findings: AnalysisFinding[],
  visitedObjectExpressions: Set<string>,
  contextName: string,
  nestingDepth: number,
): void {
  const objectKey = `${objectExpression.start ?? "0"}:${objectExpression.end ?? "0"}:${contextName}:${nestingDepth}`;
  if (visitedObjectExpressions.has(objectKey)) {
    return;
  }

  visitedObjectExpressions.add(objectKey);

  for (const property of objectExpression.properties as any[]) {
    if (!property || property.type === "SpreadElement") {
      continue;
    }

    if (property.type !== "ObjectProperty") {
      continue;
    }

    const propertyName = getObjectPropertyName(property.key);
    if (!propertyName) {
      continue;
    }

    const value = property.value;

    if (value.type === "ObjectExpression") {
      inspectObjectExpression(value, filePath, sourceText, sourceKind, findings, visitedObjectExpressions, propertyName, nestingDepth + 1);
      continue;
    }

    const referencePath = extractReferencePath(value);
    if (referencePath) {
      if (isTokenReference(referencePath)) {
        const loc = value.loc?.start ?? property.loc?.start;
        if (!loc) {
          continue;
        }

        findings.push(createFinding({
          filePath,
          sourceKind,
          propertyName,
          rawValue: referencePath.join("."),
          category: inferCategoryFromProperty(propertyName, referencePath.join(".")),
          kind: "reference",
          confidence: nestingDepth === 0 ? "high" : "medium",
          line: loc.line,
          column: loc.column + 1,
          normalizedValue: referencePath.join("."),
          referencePath,
          referenceText: referencePath.join("."),
          context: getLineText(sourceText, loc.line),
        }));
      }

      continue;
    }

    const literalText = extractLiteralText(value);
    if (literalText === null || isSafeLiteral(literalText) || /^0(?:px|rem|em)?$/.test(literalText)) {
      continue;
    }

    const category = inferCategoryFromProperty(propertyName, literalText);
    if (category === "unknown") {
      continue;
    }

    const loc = value.loc?.start ?? property.loc?.start;
    if (!loc) {
      continue;
    }

    const normalizedCategory = category;

    findings.push(createFinding({
      filePath,
      sourceKind,
      origin: "style-object",
      propertyName,
      rawValue: literalText,
      category: normalizedCategory,
      kind: "literal",
      confidence: nestingDepth === 0 ? "high" : "medium",
      line: loc.line,
      column: loc.column + 1,
      normalizedValue: normalizeValueForCategory(normalizedCategory, literalText) ?? literalText.trim(),
      referencePath: undefined,
      referenceText: undefined,
      context: getLineText(sourceText, loc.line),
    }));
  }
}

function inferCategoryFromProperty(propertyName: string, rawValue: string): TokenCategory | "unknown" {
  const normalizedProperty = propertyName.replace(/-/g, "").toLowerCase();

  if (normalizedProperty.includes("shadow")) {
    return "shadows";
  }

  if (normalizedProperty.includes("radius")) {
    return "radius";
  }

  if (normalizedProperty.includes("fontsize") || normalizedProperty === "font-size" || normalizedProperty.includes("lineheight")) {
    return "fontSizes";
  }

  if (
    normalizedProperty.includes("color") ||
    normalizedProperty.includes("background") ||
    normalizedProperty.includes("foreground") ||
    normalizedProperty.includes("border") ||
    normalizedProperty.includes("fill") ||
    normalizedProperty.includes("stroke") ||
    normalizedProperty.includes("ring")
  ) {
    return "colors";
  }

  if (
    normalizedProperty.includes("margin") ||
    normalizedProperty.includes("padding") ||
    normalizedProperty.includes("gap") ||
    normalizedProperty.includes("inset") ||
    normalizedProperty.includes("top") ||
    normalizedProperty.includes("right") ||
    normalizedProperty.includes("bottom") ||
    normalizedProperty.includes("left") ||
    normalizedProperty.includes("width") ||
    normalizedProperty.includes("height") ||
    normalizedProperty.includes("size")
  ) {
    return "spacing";
  }

  return "unknown";
}

function createFinding(input: Omit<AnalysisFinding, "context" | "confidence"> & {
  context: string;
  confidence: ConfidenceLevel;
}): AnalysisFinding {
  return input;
}

function getSourceKind(filePath: string): SourceFileKind {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".ts" || extension === ".tsx") {
    return "typescript";
  }

  return "javascript";
}

function getJSXAttributeName(nameNode: any): string | null {
  if (nameNode.type === "JSXIdentifier") {
    return nameNode.name;
  }

  return null;
}

function getCalleeName(node: any): string | null {
  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }

  return null;
}

function getObjectPropertyName(keyNode: any): string | null {
  if (keyNode.type === "Identifier") {
    return keyNode.name;
  }

  if (keyNode.type === "StringLiteral" || keyNode.type === "NumericLiteral") {
    return String(keyNode.value);
  }

  return null;
}

function extractReferencePath(node: any): string[] | null {
  if (!node) {
    return null;
  }

  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const objectPath = extractReferencePath(node.object);
    const propertyName = node.computed
      ? extractLiteralText(node.property)
      : node.property.type === "Identifier"
        ? node.property.name
        : null;

    if (!objectPath || !propertyName) {
      return null;
    }

    return [...objectPath, propertyName];
  }

  if (node.type === "Identifier") {
    return [node.name];
  }

  return null;
}

function isTokenReference(referencePath: string[]): boolean {
  return referencePath.length > 1 && (referencePath[0] === "theme" || referencePath[0] === "tokens");
}

function extractLiteralText(node: any): string | null {
  if (!node) {
    return null;
  }

  if (node.type === "StringLiteral") {
    return node.value;
  }

  if (node.type === "NumericLiteral") {
    return String(node.value);
  }

  if (node.type === "BooleanLiteral") {
    return String(node.value);
  }

  if (node.type === "NullLiteral") {
    return "null";
  }

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: any) => quasi.value.cooked ?? quasi.value.raw ?? "").join("");
  }

  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument?.type === "NumericLiteral") {
    return `-${node.argument.value}`;
  }

  return null;
}

function containsStyleLikeProperty(objectExpression: any): boolean {
  return (objectExpression.properties as any[]).some((property) => {
    if (!property || property.type !== "ObjectProperty") {
      return false;
    }

    const propertyName = getObjectPropertyName(property.key);
    if (!propertyName) {
      return false;
    }

    const normalized = propertyName.toLowerCase();
    return (
      normalized.includes("color") ||
      normalized.includes("background") ||
      normalized.includes("border") ||
      normalized.includes("padding") ||
      normalized.includes("margin") ||
      normalized.includes("gap") ||
      normalized.includes("radius") ||
      normalized.includes("shadow") ||
      normalized.includes("font") ||
      normalized.includes("width") ||
      normalized.includes("height") ||
      normalized.includes("size")
    );
  });
}

function isSafeLiteral(value: string): boolean {
  return SAFE_LITERAL_VALUES.has(value.trim().toLowerCase());
}

function isColorFunction(node: any): boolean {
  return node.type === "Function" && /^(rgb|rgba|hsl|hsla|oklch)$/i.test(node.name);
}

function getLineText(sourceText: string, lineNumber: number): string {
  const lines = sourceText.split(/\r?\n/);
  return lines[lineNumber - 1]?.trim() ?? "";
}
