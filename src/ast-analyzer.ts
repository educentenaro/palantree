import { extname } from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as csstree from "css-tree";
import type { AnalysisFinding, ConfidenceLevel, SourceFileKind, TokenCategory } from "./types.js";
import {
  buildJsReference,
  normalizeValueForCategory,
} from "./token-normalizer.js";

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
  const ast = parse(sourceText, {
    sourceType: "unambiguous",
    errorRecovery: false,
    plugins: ["jsx", "typescript", "classProperties", "classPrivateProperties", "classPrivateMethods", "decorators-legacy", "objectRestSpread", "optionalChaining", "nullishCoalescingOperator"],
  });

  traverse(ast as never, {
    JSXAttribute(path: any) {
      const attributeName = getJSXAttributeName(path.node.name);
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

  csstree.walk(ast, (node: any) => {
    if (node.type !== "Declaration") {
      return;
    }

    const propertyName = String(node.property);
    const rawValue = csstree.generate(node.value).trim();

    if (!rawValue || isSafeLiteral(rawValue) || /var\(/i.test(rawValue)) {
      return;
    }

    const category = inferCategoryFromProperty(propertyName, rawValue);
    if (category === "unknown" && !looksStyleLikeValue(rawValue)) {
      return;
    }

    const firstLiteralNode = findCssLiteralNode(node.value, category);
    if (!firstLiteralNode) {
      return;
    }

    const loc = firstLiteralNode.loc?.start ?? node.loc?.start;
    if (!loc) {
      return;
    }

    findings.push(createFinding({
      filePath,
      sourceKind,
      propertyName,
      rawValue,
      category,
      kind: "literal",
      confidence: "medium",
      line: loc.line,
      column: loc.column + 1,
      normalizedValue: normalizeValueForCategory(category === "unknown" ? inferCategoryFromLiteral(rawValue) : category, rawValue) ?? rawValue.trim(),
      referencePath: undefined,
      referenceText: undefined,
      context: getLineText(sourceText, loc.line),
    }));
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
    if (literalText === null || isSafeLiteral(literalText)) {
      continue;
    }

    const category = inferCategoryFromProperty(propertyName, literalText);
    if (category === "unknown" && !looksStyleLikeValue(literalText)) {
      continue;
    }

    const loc = value.loc?.start ?? property.loc?.start;
    if (!loc) {
      continue;
    }

    const normalizedCategory = category === "unknown" ? inferCategoryFromLiteral(literalText) : category;

    findings.push(createFinding({
      filePath,
      sourceKind,
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

function findCssLiteralNode(valueNode: any, category: TokenCategory | "unknown"): any | null {
  const children: any[] = [];
  valueNode.children?.forEach((child: any) => {
    children.push(child);
  });

  for (const child of children) {
    if (child.type === "Function" && /^var$/i.test(child.name)) {
      return null;
    }

    if (category === "colors") {
      if (child.type === "Hash" || isColorFunction(child)) {
        return child;
      }
      continue;
    }

    if (category === "shadows") {
      if (child.type === "Dimension" || child.type === "Number" || child.type === "Function" || child.type === "Hash") {
        return child;
      }
      continue;
    }

    if (category === "spacing" || category === "radius" || category === "fontSizes") {
      if (child.type === "Dimension" || child.type === "Number") {
        return child;
      }
      continue;
    }

    if (looksStyleLikeCssNode(child)) {
      return child;
    }
  }

  return null;
}

function inferCategoryFromProperty(propertyName: string, rawValue: string): TokenCategory | "unknown" {
  const normalizedProperty = propertyName.toLowerCase();
  const normalizedValue = rawValue.toLowerCase();

  if (normalizedProperty.includes("shadow") || looksShadowValue(normalizedValue)) {
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
    normalizedProperty.includes("ring") ||
    looksColorValue(normalizedValue)
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
    normalizedProperty.includes("size") ||
    looksLengthValue(normalizedValue)
  ) {
    return "spacing";
  }

  if (looksColorValue(normalizedValue)) {
    return "colors";
  }

  if (looksLengthValue(normalizedValue)) {
    return "spacing";
  }

  return "unknown";
}

function inferCategoryFromLiteral(literalText: string): TokenCategory {
  const normalized = literalText.toLowerCase();

  if (looksShadowValue(normalized)) {
    return "shadows";
  }

  if (looksColorValue(normalized)) {
    return "colors";
  }

  if (looksLengthValue(normalized)) {
    return "spacing";
  }

  return "spacing";
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

function looksColorValue(value: string): boolean {
  return /#([0-9a-f]{3,8})\b/i.test(value) || /rgba?\(/i.test(value) || /hsla?\(/i.test(value);
}

function looksLengthValue(value: string): boolean {
  return /^-?\d+(?:\.\d+)?(?:px|rem|em)?$/i.test(value.trim());
}

function looksShadowValue(value: string): boolean {
  return /\b(?:rgba?|hsla?|#[0-9a-f]{3,8})\b/i.test(value) && /\d/.test(value);
}

function looksStyleLikeValue(value: string): boolean {
  return looksColorValue(value) || looksLengthValue(value) || looksShadowValue(value);
}

function looksStyleLikeCssNode(node: any): boolean {
  return node.type === "Hash" || node.type === "Dimension" || node.type === "Number" || isColorFunction(node) || node.type === "Function";
}

function isColorFunction(node: any): boolean {
  return node.type === "Function" && /^(rgb|rgba|hsl|hsla)$/i.test(node.name);
}

function getLineText(sourceText: string, lineNumber: number): string {
  const lines = sourceText.split(/\r?\n/);
  return lines[lineNumber - 1]?.trim() ?? "";
}
