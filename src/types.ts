export const SUPPORTED_SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css"] as const;

export type SupportedSourceExtension = (typeof SUPPORTED_SOURCE_EXTENSIONS)[number];
export type SourceFileKind = "typescript" | "javascript" | "css";
export type TokenCategory = "colors" | "spacing" | "fontSizes" | "radius" | "shadows";
export type ValidationSeverity = "valid" | "warning" | "error";
export type AnalysisKind = "literal" | "reference" | "theme";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface CliConfig {
  preset?: "shadcn";
  figmaPath: string;
  srcPath: string;
  exclude?: string[];
}

export interface TokenDocument {
  sourceFile: string;
  modeName?: string;
  data: Record<string, unknown>;
}

export interface RawToken {
  sourceFile: string;
  modeName?: string;
  pathSegments: string[];
  tokenName: string;
  type: string;
  rawValue: unknown;
  extensions?: Record<string, unknown>;
}

export interface NormalizedToken {
  id: string;
  category: TokenCategory;
  pathSegments: string[];
  tokenName: string;
  sourceFile: string;
  modeName?: string;
  rawValue: unknown;
  normalizedValue: string;
  cssVariableName: string;
  jsReference: string;
}

export interface NormalizedTokenIndex {
  tokens: NormalizedToken[];
  byCategory: Record<TokenCategory, NormalizedToken[]>;
  byValue: Record<TokenCategory, Map<string, NormalizedToken[]>>;
  byPath: Map<string, NormalizedToken>;
}

export interface AnalysisFinding {
  origin?: "css" | "style-object" | "tailwind";
  utilityPrefix?: string;
  className?: string;
  variants?: string;
  modifier?: string;
  replacementBefore?: string;
  replacementAfter?: string;
  tailwindColorValue?: string;
  themeMode?: "Light" | "Dark";
  themeTokenName?: string;
  filePath: string;
  sourceKind: SourceFileKind;
  line: number;
  column: number;
  propertyName: string;
  rawValue: string;
  normalizedValue: string;
  category: TokenCategory | "unknown";
  kind: AnalysisKind;
  confidence: ConfidenceLevel;
  context: string;
  referencePath?: string[];
  referenceText?: string;
}

export interface ValidationResult {
  finding: AnalysisFinding;
  severity: ValidationSeverity;
  message: string;
  suggestion?: string;
  matchedToken?: NormalizedToken;
  matchedTokens?: NormalizedToken[];
}

export interface ReportSummary {
  valid: number;
  warning: number;
  error: number;
}
