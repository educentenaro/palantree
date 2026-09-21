import type {
  NormalizedToken,
  NormalizedTokenIndex,
  RawToken,
  TokenCategory,
} from "./types.js";

const COLOR_SEGMENT_HINTS = new Set([
  "color",
  "colors",
  "text",
  "background",
  "foreground",
  "border",
  "fill",
  "stroke",
  "ring",
  "accent",
  "primary",
  "secondary",
  "destructive",
  "muted",
  "popover",
  "card",
  "sidebar",
  "input",
  "overlay",
  "surface",
]);

const SPACING_SEGMENT_HINTS = new Set([
  "spacing",
  "space",
  "gap",
  "margin",
  "padding",
  "inset",
  "size",
  "width",
  "height",
  "top",
  "right",
  "bottom",
  "left",
]);

const RADIUS_SEGMENT_HINTS = new Set(["radius", "rounded", "corner"]);
const FONT_SIZE_SEGMENT_HINTS = new Set(["font", "text", "typography", "size"]);
const SHADOW_SEGMENT_HINTS = new Set(["shadow"]);

export function normalizeTokens(rawTokens: RawToken[]): NormalizedTokenIndex {
  const tokens: NormalizedToken[] = [];
  const byCategory: NormalizedTokenIndex["byCategory"] = {
    colors: [],
    spacing: [],
    fontSizes: [],
    radius: [],
    shadows: [],
  };
  const byValue: NormalizedTokenIndex["byValue"] = {
    colors: new Map(),
    spacing: new Map(),
    fontSizes: new Map(),
    radius: new Map(),
    shadows: new Map(),
  };
  const byPath = new Map<string, NormalizedToken>();
  const rawTokenLookup = new Map(rawTokens.map((token) => [token.pathSegments.join("."), token]));

  for (const rawToken of rawTokens) {
    const category = inferTokenCategory(rawToken);

    if (!category) {
      continue;
    }

    const resolvedValue = resolveTokenValue(rawToken.rawValue, rawTokenLookup, new Set([rawToken.pathSegments.join(".")]));
    const normalizedValue = normalizeValueForCategory(category, resolvedValue);

    if (!normalizedValue) {
      continue;
    }

    const normalizedToken: NormalizedToken = {
      id: `${rawToken.sourceFile}:${rawToken.pathSegments.join(".")}:${rawToken.modeName ?? "default"}`,
      category,
      pathSegments: rawToken.pathSegments,
      tokenName: rawToken.tokenName,
      sourceFile: rawToken.sourceFile,
      modeName: rawToken.modeName,
      rawValue: rawToken.rawValue,
      normalizedValue,
      cssVariableName: buildCssVariableName(rawToken.pathSegments),
      jsReference: buildJsReference(rawToken.pathSegments),
    };

    tokens.push(normalizedToken);
    byCategory[category].push(normalizedToken);
    byPath.set(rawToken.pathSegments.join("."), normalizedToken);

    const bucket = byValue[category].get(normalizedValue) ?? [];
    bucket.push(normalizedToken);
    byValue[category].set(normalizedValue, bucket);
  }

  for (const category of Object.keys(byCategory) as TokenCategory[]) {
    byCategory[category].sort((left, right) => left.tokenName.localeCompare(right.tokenName));

    for (const [value, matchedTokens] of byValue[category]) {
      matchedTokens.sort((left, right) => left.tokenName.localeCompare(right.tokenName));
      byValue[category].set(value, matchedTokens);
    }
  }

  tokens.sort((left, right) => left.tokenName.localeCompare(right.tokenName));

  return {
    tokens,
    byCategory,
    byValue,
    byPath,
  };
}

export function inferTokenCategory(token: RawToken): TokenCategory | null {
  const segments = token.pathSegments.map((segment) => segment.toLowerCase());
  const type = token.type.toLowerCase();

  if (type === "color") {
    return "colors";
  }

  if (type === "shadow" || segments.some((segment) => SHADOW_SEGMENT_HINTS.has(segment))) {
    return "shadows";
  }

  if (segments.some((segment) => COLOR_SEGMENT_HINTS.has(segment))) {
    return "colors";
  }

  if (segments.some((segment) => RADIUS_SEGMENT_HINTS.has(segment))) {
    return "radius";
  }

  if (segments.some((segment) => FONT_SIZE_SEGMENT_HINTS.has(segment)) && type === "number") {
    return "fontSizes";
  }

  if (segments.some((segment) => SPACING_SEGMENT_HINTS.has(segment)) || segments[0] === "spacing") {
    return "spacing";
  }

  if (type === "number" && segments[0] === "radius") {
    return "radius";
  }

  return null;
}

export function normalizeValueForCategory(category: TokenCategory, input: unknown): string | null {
  switch (category) {
    case "colors":
      return normalizeColorValue(input);
    case "spacing":
    case "fontSizes":
    case "radius":
      return normalizeNumericValue(input);
    case "shadows":
      return normalizeShadowValue(input);
  }
}

export function normalizeColorValue(input: unknown): string | null {
  if (typeof input === "string") {
    const trimmed = input.trim().toLowerCase();

    const hexMatch = trimmed.match(/^#([0-9a-f]{3,8})$/i);
    if (hexMatch) {
      return normalizeHexValue(trimmed);
    }

    const rgbMatch = trimmed.match(/^rgba?\((.+)\)$/i);
    if (rgbMatch) {
      return normalizeRgbValue(rgbMatch[1]);
    }

    const hslMatch = trimmed.match(/^hsla?\((.+)\)$/i);
    if (hslMatch) {
      return normalizeHslValue(hslMatch[1]);
    }

    const oklchMatch = trimmed.match(/^oklch\((.+)\)$/i);
    if (oklchMatch) {
      return normalizeOklchValue(oklchMatch[1]);
    }

    return null;
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;

    if (typeof value.hex === "string") {
      const alpha = typeof value.alpha === "number" ? value.alpha : 1;
      return normalizeHexValue(value.hex, alpha);
    }

    if (Array.isArray(value.components) && value.components.every((component) => typeof component === "number")) {
      const components = value.components as number[];
      const alpha = typeof value.alpha === "number" ? value.alpha : 1;

      if (components.length >= 3) {
        const [red, green, blue] = components;
        return rgbaToHex(red, green, blue, alpha);
      }
    }
  }

  return null;
}

export function normalizeNumericValue(input: unknown): string | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return formatNumber(input);
  }

  if (typeof input === "string") {
    const trimmed = input.trim().toLowerCase();
    const match = trimmed.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|%|vh|vw)?$/);

    if (match) {
      // Unitless Figma dimensions are pixels. Relative units need runtime
      // context and must never match a pixel token just by their number.
      return formatNumber(Number(match[1])) + (match[2] && match[2] !== "px" ? match[2] : "");
    }
  }

  return null;
}

export function normalizeShadowValue(input: unknown): string | null {
  if (typeof input === "string") {
    return input.trim().toLowerCase().replace(/\s+/g, " ");
  }

  return null;
}

export function buildCssVariableName(pathSegments: string[]): string {
  const normalized = pathSegments
    .map((segment) => segment
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase())
    .filter(Boolean)
    .join("-");

  return /^\d/.test(normalized) ? `token-${normalized}` : normalized;
}

export function buildJsReference(pathSegments: string[]): string {
  let reference = "tokens";

  for (const segment of pathSegments) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      reference += `.${segment}`;
      continue;
    }

    reference += `[${JSON.stringify(segment)}]`;
  }

  return reference;
}

export function findTokensByValue(
  index: NormalizedTokenIndex,
  category: TokenCategory,
  normalizedValue: string,
): NormalizedToken[] {
  return index.byValue[category].get(normalizedValue) ?? [];
}

export function findTokenByPath(index: NormalizedTokenIndex, pathSegments: string[]): NormalizedToken | undefined {
  return index.byPath.get(pathSegments.join("."));
}

export function resolveTokenValue(
  input: unknown,
  tokenLookup: Map<string, RawToken>,
  seen: Set<string>,
): unknown {
  if (typeof input === "string") {
    const aliasMatch = input.trim().match(/^\{(.+)\}$/);

    if (aliasMatch) {
      const aliasPath = aliasMatch[1];
      if (!seen.has(aliasPath) && tokenLookup.has(aliasPath)) {
        seen.add(aliasPath);
        return resolveTokenValue(tokenLookup.get(aliasPath)?.rawValue, tokenLookup, seen);
      }
    }
  }

  return input;
}

function normalizeHexValue(hex: string, alpha = 1): string | null {
  const normalized = hex.trim().replace(/^#/, "");

  if (![3, 4, 6, 8].includes(normalized.length)) {
    return null;
  }

  let red = 0;
  let green = 0;
  let blue = 0;
  let resolvedAlpha = alpha;

  if (normalized.length === 3 || normalized.length === 4) {
    red = Number.parseInt(normalized[0] + normalized[0], 16);
    green = Number.parseInt(normalized[1] + normalized[1], 16);
    blue = Number.parseInt(normalized[2] + normalized[2], 16);

    if (normalized.length === 4) {
      resolvedAlpha = Number.parseInt(normalized[3] + normalized[3], 16) / 255;
    }
  } else {
    red = Number.parseInt(normalized.slice(0, 2), 16);
    green = Number.parseInt(normalized.slice(2, 4), 16);
    blue = Number.parseInt(normalized.slice(4, 6), 16);

    if (normalized.length === 8) {
      resolvedAlpha = Number.parseInt(normalized.slice(6, 8), 16) / 255;
    }
  }

  if (![red, green, blue].every(Number.isFinite)) {
    return null;
  }

  return rgbaToHex(red, green, blue, resolvedAlpha);
}

function normalizeRgbValue(input: string): string | null {
  const parts = input.trim().split(/\s*[,/]\s*|\s+/);

  if (parts.length < 3) {
    return null;
  }

  const red = parseColorChannel(parts[0]);
  const green = parseColorChannel(parts[1]);
  const blue = parseColorChannel(parts[2]);
  const alpha = parts[3] !== undefined ? (parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3])) : 1;

  if ([red, green, blue].some((component) => component === null)) {
    return null;
  }

  return rgbaToHex(red as number, green as number, blue as number, Number.isFinite(alpha) ? alpha : 1);
}

function normalizeHslValue(input: string): string | null {
  const parts = input.trim().split(/\s*[,/]\s*|\s+/);

  if (parts.length < 3) {
    return null;
  }

  const hue = Number(parts[0].replace(/deg$/i, ""));
  const saturation = Number(parts[1].replace(/%$/, ""));
  const lightness = Number(parts[2].replace(/%$/, ""));
  const alpha = parts[3] !== undefined ? (parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3])) : 1;

  if (![hue, saturation, lightness].every(Number.isFinite)) {
    return null;
  }

  const [red, green, blue] = hslToRgb(hue, saturation, lightness);
  return rgbaToHex(red, green, blue, Number.isFinite(alpha) ? alpha : 1);
}

function parseColorChannel(value: string): number | null {
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? Math.round((percent / 100) * 255) : null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOklchValue(input: string): string | null {
  const [channels, alphaText] = input.trim().split(/\s*\/\s*/);
  const parts = channels.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const lightness = parts[0].endsWith("%") ? Number(parts[0].slice(0, -1)) / 100 : Number(parts[0]);
  const chroma = Number(parts[1]);
  const hue = Number(parts[2].replace(/deg$/i, ""));
  const alpha = alphaText === undefined ? 1 : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;

  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3, m = mRoot ** 3, s = sRoot ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const rgb = linear.map(channel => 255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055));
  return rgbaToHex(rgb[0], rgb[1], rgb[2], alpha);
}

function rgbaToHex(red: number, green: number, blue: number, alpha = 1): string {
  const redByte = clampByte(red);
  const greenByte = clampByte(green);
  const blueByte = clampByte(blue);
  const alphaByte = clampByte(Math.round(alpha * 255));

  const base = `#${toHex(redByte)}${toHex(greenByte)}${toHex(blueByte)}`;
  return alphaByte === 255 ? base.toLowerCase() : `${base}${toHex(alphaByte)}`.toLowerCase();
}

function hslToRgb(hue: number, saturationPercent: number, lightnessPercent: number): [number, number, number] {
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;

  let red = 0;
  let green = 0;
  let blue = 0;

  if (sector >= 0 && sector < 1) {
    red = chroma;
    green = secondary;
  } else if (sector < 2) {
    red = secondary;
    green = chroma;
  } else if (sector < 3) {
    green = chroma;
    blue = secondary;
  } else if (sector < 4) {
    green = secondary;
    blue = chroma;
  } else if (sector < 5) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }

  return [Math.round((red + match) * 255), Math.round((green + match) * 255), Math.round((blue + match) * 255)];
}

function formatNumber(value: number): string {
  const rounded = Number(value.toFixed(4));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
