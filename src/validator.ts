import type { NormalizedToken, NormalizedTokenIndex, ValidationResult } from "./types.js";
import {
  findTokensByValue,
  findTokenByPath,
  normalizeValueForCategory,
} from "./token-normalizer.js";
import type { TokenCategory } from "./types.js";
import type { AnalysisFinding } from "./types.js";
import { withOpacity } from "./tailwind-analyzer.js";
import {
  isBuiltInSemanticClass,
  isNativeCssValue,
  isSemanticToken,
  semanticUtilityName,
  themePrimitiveName,
} from "./shadcn-baseline.js";

export function validateFindings(
  findings: import("./types.js").AnalysisFinding[],
  tokenIndex: NormalizedTokenIndex,
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const finding of findings) {
    if (finding.kind === "theme") {
      results.push(validateThemeFinding(finding, tokenIndex));
      continue;
    }
    if (finding.kind === "reference") {
      results.push(validateReferenceFinding(finding, tokenIndex));
      continue;
    }

    results.push(validateLiteralFinding(finding, tokenIndex));
  }

  return results.sort((left, right) => {
    const fileCompare = left.finding.filePath.localeCompare(right.finding.filePath);
    if (fileCompare !== 0) {
      return fileCompare;
    }

    if (left.finding.line !== right.finding.line) {
      return left.finding.line - right.finding.line;
    }

    return left.finding.column - right.finding.column;
  });
}

function validateReferenceFinding(
  finding: import("./types.js").AnalysisFinding,
  tokenIndex: NormalizedTokenIndex,
): ValidationResult {
  if (finding.origin === "tailwind") {
    const base = finding.normalizedValue.replace(/^-/, "");
    const token = tokenIndex.tokens.find((item) => item.category === finding.category && semanticUtilityName(item, finding.utilityPrefix!) === base);
    if (token && !finding.modifier) return { finding, severity: "valid", message: `Uses token class ${finding.className}`, matchedToken: token };
    if (token && finding.modifier) {
      const composed = withOpacity(token.normalizedValue, finding.modifier);
      const alphaToken = composed && semanticMatchesByValue(tokenIndex, "colors", composed)
        .find(item => semanticUtilityName(item, finding.utilityPrefix!) === `${base}-${finding.modifier}`);
      if (alphaToken) return { finding, severity: "valid", message: `Uses token class ${finding.className}`, matchedToken: alphaToken };
    }
    if (isBuiltInSemanticClass(finding) && !finding.modifier) {
      return { finding, severity: "valid", message: `Uses shadcn semantic class ${finding.className}` };
    }
    const matchedTokens = finding.tailwindColorValue
      ? rankTokens(semanticMatchesByValue(tokenIndex, "colors", finding.tailwindColorValue)
        .filter(item => semanticUtilityName(item, finding.utilityPrefix!) !== undefined), finding.utilityPrefix!)
      : [];
    const bestToken = matchedTokens[0];
    return {
      finding,
      severity: "error",
      message: `Class "${finding.className}" is not a semantic shadcn color`,
      suggestion: bestToken ? buildSuggestion(bestToken, finding, false) : undefined,
      matchedToken: bestToken,
      matchedTokens: matchedTokens.length ? matchedTokens : undefined,
    };
  }
  const referencePath = finding.referencePath ?? [];
  const referencedSegments = referencePath[0] === "theme" || referencePath[0] === "tokens" ? referencePath.slice(1) : referencePath;
  const exactToken = referencedSegments.length > 0 ? findTokenByPath(tokenIndex, referencedSegments) : undefined;
  const referenceText = finding.referenceText ?? referencedSegments.join(".");

  if (exactToken) {
    return {
      finding,
      severity: "valid",
      message: `Uses token reference ${referenceText}`,
      suggestion: buildSuggestion(exactToken),
      matchedToken: exactToken,
    };
  }

  if (referencePath[0] === "theme" || referencePath[0] === "tokens") {
    return {
      finding,
      severity: "valid",
      message: `Uses token reference ${referenceText}`,
    };
  }

  return {
    finding,
    severity: "warning",
    message: `Reference ${referenceText} could not be resolved against the token set`,
  };
}

function validateLiteralFinding(
  finding: import("./types.js").AnalysisFinding,
  tokenIndex: NormalizedTokenIndex,
): ValidationResult {
  const category = finding.category;

  if (category === "unknown") {
    return {
      finding,
      severity: "warning",
      message: `Literal "${finding.rawValue}" requires manual review`,
    };
  }

  const normalizedValue = finding.normalizedValue || normalizeValueForCategory(category, finding.rawValue) || finding.rawValue.trim();
  if (finding.origin === "css" && category !== "colors" && isNativeCssValue(category, normalizedValue)) {
    return { finding, severity: "valid", message: `Uses native shadcn/Tailwind ${formatCategoryLabel(category)} value` };
  }
  let matchedTokens = semanticMatchesByValue(tokenIndex, category, normalizedValue);
  if (finding.origin === "tailwind") {
    matchedTokens = matchedTokens.filter(item => semanticUtilityName(item, finding.utilityPrefix!) !== undefined);
  }
  if (finding.origin === "tailwind" && category === "colors" && finding.modifier) {
    for (const token of tokenIndex.byCategory.colors.filter(isSemanticToken)) {
      if (withOpacity(token.normalizedValue, finding.modifier) === normalizedValue && !matchedTokens.includes(token)) matchedTokens.push(token);
    }
  }
  const preferred = finding.utilityPrefix ?? cssPrefix(finding.propertyName);
  rankTokens(matchedTokens, preferred);
  const tokenLabel = formatCategoryLabel(category);
  const bestToken = matchedTokens[0];

  if (category === "fontSizes") {
    if (bestToken) {
      return {
        finding,
        severity: "warning",
        message: `Font size "${finding.rawValue}" should use a token instead of a hardcoded value`,
        suggestion: buildSuggestion(bestToken, finding),
        matchedToken: bestToken,
        matchedTokens,
      };
    }

    return {
      finding,
      severity: "warning",
      message: `Font size "${finding.rawValue}" not found in typography tokens`,
    };
  }

  if (bestToken) {
    return {
      finding,
      severity: "error",
      message: `Hardcoded ${tokenLabel} "${finding.rawValue}"`,
      suggestion: buildSuggestion(bestToken, finding),
      matchedToken: bestToken,
      matchedTokens,
    };
  }

  return {
    finding,
    severity: "error",
    message: `Hardcoded ${tokenLabel} "${finding.rawValue}"`,
  };
}

function cssPrefix(property: string): string {
  if (/radius/i.test(property)) return "rounded";
  if (/border/i.test(property)) return "border";
  if (/background/i.test(property)) return "bg";
  if (/color|foreground/i.test(property)) return "text";
  return property;
}

function semanticMatchesByValue(index: NormalizedTokenIndex, category: TokenCategory, value: string): NormalizedToken[] {
  return findTokensByValue(index, category, value).filter(isSemanticToken);
}

function rankTokens(tokens: NormalizedToken[], prefix: string): NormalizedToken[] {
  const score = (token: NormalizedToken) => {
    const name = token.pathSegments.at(-1) ?? "";
    if (name === `${prefix}-primary-foreground`) return 4;
    if (name === `${prefix}-foreground`) return 3;
    if (name === `${prefix}-primary`) return 2;
    return name.startsWith(`${prefix}-`) ? 1 : 0;
  };
  return tokens.sort((a, b) => score(b) - score(a) || a.tokenName.localeCompare(b.tokenName) || a.id.localeCompare(b.id));
}

function buildSuggestion(token: NormalizedToken, finding?: AnalysisFinding, preserveModifier = true): string {
  const variable = `var(--${token.cssVariableName})`;
  if (finding?.origin === "tailwind") {
    const modifier = preserveModifier && finding.modifier && withOpacity(token.normalizedValue, finding.modifier) === finding.normalizedValue ? `/${finding.modifier}` : "";
    const utility = semanticUtilityName(token, finding.utilityPrefix!) ?? `${finding.utilityPrefix}-[${variable}]`;
    return `${finding.variants ?? ""}${utility}${modifier}${finding.replacementAfter ?? ""}`;
  }
  if (finding?.origin === "css") return `${finding.replacementBefore ?? ""}${variable}${finding.replacementAfter ?? ""} (token ${token.pathSegments.at(-1)})`;
  return variable;
}

function validateThemeFinding(finding: AnalysisFinding, tokenIndex: NormalizedTokenIndex): ValidationResult {
  const expectedName = themePrimitiveName(finding.propertyName);
  const mode = finding.themeMode ?? "Light";
  const expected = tokenIndex.byCategory.colors.find(token => {
    const parts = token.pathSegments.map(part => part.toLowerCase());
    const colorIndex = parts.indexOf("color");
    return parts[0] === "primitives" && parts[1] === mode.toLowerCase() && colorIndex >= 0
      && parts[colorIndex + 1] === expectedName && parts.at(-1) === "100";
  });
  if (!expected) return { finding, severity: "valid", message: `Uses shadcn ${mode} theme variable ${finding.propertyName}` };
  if (colorsClose(finding.normalizedValue, expected.normalizedValue)) {
    return { finding, severity: "valid", message: `${finding.propertyName} matches ${expected.tokenName}`, matchedToken: expected };
  }
  const value = expected.normalizedValue.toUpperCase();
  return {
    finding,
    severity: "error",
    message: `${mode} theme variable "${finding.propertyName}" differs from ${expected.tokenName}`,
    suggestion: `${finding.propertyName}: ${value}`,
    matchedToken: expected,
  };
}

function colorsClose(left: string, right: string): boolean {
  const bytes = (value: string) => value.match(/[0-9a-f]{2}/gi)?.map(part => Number.parseInt(part, 16)) ?? [];
  const a = bytes(left), b = bytes(right);
  return a.length >= 3 && b.length >= 3 && a.slice(0, 3).every((value, index) => Math.abs(value - b[index]) <= 2)
    && (a[3] ?? 255) === (b[3] ?? 255);
}

function formatCategoryLabel(category: TokenCategory): string {
  switch (category) {
    case "colors":
      return "color";
    case "spacing":
      return "spacing";
    case "fontSizes":
      return "font size";
    case "radius":
      return "radius";
    case "shadows":
      return "shadow";
  }

  return category;
}
