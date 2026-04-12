import fs from "node:fs";
import path from "node:path";

const workspaceRoot = "C:/Users/jery/.pi/agent/extensions/pi-unify-provider";
const packages = [
  {
    id: "pi-coding-agent",
    root: path.join(workspaceRoot, "node_modules/@mariozechner/pi-coding-agent"),
  },
  {
    id: "pi-ai",
    root: path.join(workspaceRoot, "node_modules/@mariozechner/pi-ai"),
  },
];

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

function rel(root, p) {
  return toPosix(path.relative(root, p));
}

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, predicate, out);
      continue;
    }
    if (!predicate || predicate(full)) out.push(full);
  }
  return out;
}

function normalizeStatement(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/g, ";")
    .trim();
}

function collectMatches(src, regex) {
  const items = [];
  let m;
  while ((m = regex.exec(src)) !== null) {
    items.push(m[0]);
  }
  return items;
}

function extractExportStatements(src) {
  const statements = [];

  // export * from "...";
  statements.push(...collectMatches(src, /^\s*export\s+\*\s+from\s+["'][^"']+["']\s*;?/gm));

  // export { ... } from "..."; (single/multi-line)
  statements.push(...collectMatches(src, /export\s+(?:type\s+)?\{[\s\S]*?\}\s*(?:from\s+["'][^"']+["'])?\s*;/g));

  // export default ...
  statements.push(...collectMatches(src, /^\s*export\s+default\s+[\s\S]*?;$/gm));

  // declaration exports
  statements.push(
    ...collectMatches(
      src,
      /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|function|const|enum|namespace)\s+[A-Za-z_$][A-Za-z0-9_$]*/gm,
    ),
  );

  // export type Foo = ... (when previous regex misses due complex formatting)
  statements.push(
    ...collectMatches(src, /^\s*export\s+type\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[\s\S]*?;$/gm),
  );

  // export declare function foo(...) ...; (first regex already catches prefix only)
  // keep full signature variants where available
  statements.push(
    ...collectMatches(src, /^\s*export\s+(?:declare\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^\n]*\)\s*:\s*[^;]+;$/gm),
  );

  const normalized = Array.from(
    new Set(
      statements
        .map(normalizeStatement)
        .filter((s) => s.startsWith("export ")),
    ),
  );

  normalized.sort((a, b) => a.localeCompare(b));
  return normalized;
}

function extractPackageCatalog(pkg) {
  const docsDir = path.join(pkg.root, "docs");
  const examplesDir = path.join(pkg.root, "examples");
  const distDir = path.join(pkg.root, "dist");

  const docs = walk(docsDir, (p) => p.endsWith(".md")).map((p) => rel(pkg.root, p)).sort();
  const examples = walk(examplesDir, () => true).map((p) => rel(pkg.root, p)).sort();

  const dtsFiles = walk(distDir, (p) => p.endsWith(".d.ts")).sort();

  const exportCatalog = [];
  let totalExportStatements = 0;

  for (const file of dtsFiles) {
    const src = fs.readFileSync(file, "utf8");
    const statements = extractExportStatements(src);
    totalExportStatements += statements.length;
    exportCatalog.push({
      file: rel(pkg.root, file),
      statements,
    });
  }

  const fileCount = walk(pkg.root, () => true).length;
  const distFileCount = walk(distDir, () => true).length;

  return {
    packageId: pkg.id,
    root: toPosix(pkg.root),
    fileCount,
    distFileCount,
    docs,
    examples,
    dtsFileCount: dtsFiles.length,
    totalExportStatements,
    exportCatalog,
  };
}

function renderPackageSection(data) {
  const lines = [];
  lines.push(`## ${data.packageId}`);
  lines.push("");
  lines.push(`- package root: \`${data.root}\``);
  lines.push(`- files (excluding nested node_modules): ${data.fileCount}`);
  lines.push(`- dist files: ${data.distFileCount}`);
  lines.push(`- dist .d.ts files: ${data.dtsFileCount}`);
  lines.push(`- extracted export statements: ${data.totalExportStatements}`);
  lines.push("");

  lines.push("### Docs files");
  lines.push("");
  if (data.docs.length === 0) {
    lines.push("- (none)");
  } else {
    for (const doc of data.docs) lines.push(`- \`${doc}\``);
  }
  lines.push("");

  lines.push("### Example files");
  lines.push("");
  if (data.examples.length === 0) {
    lines.push("- (none)");
  } else {
    for (const ex of data.examples) lines.push(`- \`${ex}\``);
  }
  lines.push("");

  lines.push("### Export catalog from dist declarations");
  lines.push("");

  for (const entry of data.exportCatalog) {
    lines.push(`#### \`${entry.file}\``);
    lines.push("");
    if (entry.statements.length === 0) {
      lines.push("- (no exported declaration statements detected)");
    } else {
      for (const statement of entry.statements) {
        lines.push(`- \`${statement}\``);
      }
    }
    lines.push("");
  }

  return lines;
}

const packageData = packages.map(extractPackageCatalog);

const outLines = [];
outLines.push("# Pi Extension API Catalog (Auto-generated)");
outLines.push("");
outLines.push(
  "This file is generated by `.analysis/extract-api-catalog.mjs` and inventories package docs/examples plus exported declarations from all `dist/**/*.d.ts` files.",
);
outLines.push("");
outLines.push(`Generated at: ${new Date().toISOString()}`);
outLines.push("");

for (const data of packageData) {
  outLines.push(...renderPackageSection(data));
}

const outputPath = path.join(workspaceRoot, ".analysis", "api-catalog.md");
fs.writeFileSync(outputPath, outLines.join("\n"), "utf8");

const summaryPath = path.join(workspaceRoot, ".analysis", "api-catalog-summary.json");
fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    packageData.map((p) => ({
      packageId: p.packageId,
      root: p.root,
      fileCount: p.fileCount,
      distFileCount: p.distFileCount,
      docs: p.docs.length,
      examples: p.examples.length,
      dtsFileCount: p.dtsFileCount,
      totalExportStatements: p.totalExportStatements,
    })),
    null,
    2,
  ),
  "utf8",
);

console.log(`Wrote ${outputPath}`);
console.log(`Wrote ${summaryPath}`);
