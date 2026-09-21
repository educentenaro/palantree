import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSourceFile } from "../../dist/ast-analyzer.js";
import { normalizeTokens } from "../../dist/token-normalizer.js";
import { validateFindings } from "../../dist/validator.js";
import { loadRawTokens } from "../../dist/figma-parser.js";
import { fileURLToPath } from "node:url";

const index = normalizeTokens(["text-primary", "bg-primary", "border-primary"].map(name => ({
  sourceFile: "tokens.json", tokenName: name, pathSegments: ["Tokens", "Default", name.split("-")[0], name], type: "color", rawValue: "#FB640F",
})));
async function validate(source, extension = "jsx") {
  return validateFindings(await analyzeSourceFile(`fixture.${extension}`, source), index);
}

test("selects semantic colors by utility and preserves variants and opacity", async () => {
  const results = await validate('<div className="bg-[#FB640F] hover:text-[#fb640f] md:border-[#FB640F] bg-[#FB640F]/90" />');
  assert.deepEqual(results.map(r => r.suggestion), ["bg-primary", "hover:text-primary", "md:border-primary", "bg-primary/90"]);
  assert.ok(results.every(r => r.severity === "error"));
  assert.equal(results[0].finding.column, 17);
});

test("validates semantic names while ignoring structural classes", async () => {
  const results = await validate('<div className="grid flex items-center bg-primary border-primary bg-inexistente" />');
  assert.deepEqual(results.map(r => r.severity), ["valid", "valid", "error"]);
});

test("inspects composition without duplicate results or CVA condition values", async () => {
  const results = await validate(`
    const button = cva('bg-[#FB640F]', {variants: {size: {sm: 'border-[#FB640F]'}}, defaultVariants: {size: 'sm'}, compoundVariants: [{size: 'bg-inexistent', class: 'text-[#FB640F]'}]});
    const classes = clsx(['bg-primary'], {'border-primary': enabled});
    const x = classnames('text-primary');
    const App = () => <div className={cn('bg-[#FB640F]', active && 'border-[#FB640F]', active ? 'text-primary' : 'bg-primary')} />;
  `);
  assert.equal(results.length, 10);
  assert.equal(results.filter(r => r.severity === "error").length, 5);
});

test("templates inspect complete static classes and branches but skip assembled classes", async () => {
  const results = await validate("const App = () => <div className={`bg-[#FB640F] ${ok ? 'border-[#FB640F]' : 'text-primary'} bg-${color} text-[${size}px]`} />;");
  assert.deepEqual(results.map(r => r.finding.className), ["bg-[#FB640F]", "border-[#FB640F]", "text-primary"]);
});

test("extracts CSS shorthand color with exact location and complete replacement", async () => {
  const results = await validate('a { border: 2px solid #FB640F !important; }', 'css');
  assert.equal(results.length, 1);
  assert.equal(results[0].finding.rawValue, '#FB640F');
  assert.equal(results[0].finding.column, 23);
  assert.equal(results[0].matchedToken.tokenName, 'border-primary');
  assert.equal(results[0].suggestion, 'border: 2px solid var(--tokens-default-border-border-primary) !important (token border-primary)');
});

test("finds gradient colors and literals alongside variables; ignores weight and zero", async () => {
  const results = await validate('a { background: linear-gradient(var(--existing), #FB640F); border: var(--width) solid #FB640F; padding: 0 12px; font-weight: 700; }', 'css');
  assert.deepEqual(results.map(r => [r.finding.category, r.finding.rawValue]), [['colors', '#FB640F'], ['colors', '#FB640F'], ['spacing', '12px']]);
  assert.equal(results[0].matchedToken.tokenName, 'bg-primary');
});

test("recognizes all supported arbitrary categories without inventing a match", async () => {
  const results = await validate('<div className="p-[13px] w-[99px] rounded-[7px] text-[15px] shadow-[0_2px_4px_#000] bg-[#123456]" />');
  assert.deepEqual(results.map(r => r.finding.category), ['spacing', 'spacing', 'radius', 'fontSizes', 'shadows', 'colors']);
  assert.ok(results.every(r => !r.suggestion));
});

test("spacing scales and directional radius utilities resolve by category", async () => {
  const tokens = normalizeTokens([
    {sourceFile: 'tokens.json', tokenName: 'Tokens.Default.spacing.4', pathSegments: ['Tokens', 'Default', 'spacing', '4'], type: 'number', rawValue: 16},
    {sourceFile: 'tokens.json', tokenName: 'Tokens.Default.radius.rounded-lg', pathSegments: ['Tokens', 'Default', 'radius', 'rounded-lg'], type: 'number', rawValue: 8},
  ]);
  const findings = await analyzeSourceFile('test.jsx', '<div className="p-4 -mt-4 rounded-t-lg p-[16px] rounded-t-[8px] p-[16rem]" />');
  const results = validateFindings(findings, tokens);
  assert.deepEqual(results.map(r => r.severity), ['error', 'error', 'error']);
  assert.deepEqual(results.map(r => r.suggestion), ['p-4', 'rounded-t-lg', undefined]);
});

test("opacity must match exactly, including unsupported modifiers", async () => {
  const results = await validate('<div className="bg-[#FB640F]/[var(--alpha)] bg-[rgb(251_100_15)] hover:!bg-[#FB640F] bg-[#FB640F]!" />');
  assert.deepEqual(results.map(r => r.suggestion), [undefined, 'bg-primary', 'hover:!bg-primary', 'bg-primary!']);
});

test("accepts the shadcn baseline and reports only non-semantic named colors", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/shadcn.tokens.json", import.meta.url));
  const tokens = normalizeTokens(await loadRawTokens(fixture));
  const findings = await analyzeSourceFile("test.jsx", '<div className="px-2.5 text-sm shadow-sm max-w-7xl border-b focus-visible:ring-ring text-card-foreground bg-primary text-white border-white/10 shadow-black/40" />');
  const results = validateFindings(findings, tokens);
  assert.deepEqual(results.map(result => result.finding.className), ["focus-visible:ring-ring", "text-card-foreground", "bg-primary", "text-white", "border-white/10", "shadow-black/40"]);
  assert.deepEqual(results.map(result => result.severity), ["valid", "valid", "valid", "error", "error", "error"]);
  assert.equal(results[3].suggestion, "text-primary-foreground");
  assert.equal(results[4].suggestion, undefined);
});

test("validates shadcn Light and Dark CSS variables and ignores theme infrastructure", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/shadcn.tokens.json", import.meta.url));
  const tokens = normalizeTokens(await loadRawTokens(fixture));
  const css = `
    :root { --primary: oklch(0.6875 0.2009 42.5604); --shadow-sm: 0 1px 3px #000; --font-sans: sans-serif; --chart-1: #123456; }
    .dark { --primary: #FFFFFF; --background: #0A0A0A; }
    @theme inline { --color-primary: var(--primary); --shadow-sm: var(--shadow-sm); }
  `;
  const results = validateFindings(await analyzeSourceFile("theme.css", css), tokens);
  assert.equal(results.length, 4);
  assert.deepEqual(results.map(result => result.severity), ["valid", "valid", "error", "valid"]);
  assert.equal(results[2].suggestion, "--primary: #192A56");
});
