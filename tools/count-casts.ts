// The lab's budget: fewer than five type assertions (`x as T`) in the code base, each one with a
// comment saying why it is needed, and no `any` at all. This script counts them with the
// TypeScript compiler API (a regex would trip over strings and comments) so the number in the
// README is a measurement, not a feeling.
//
//   node tools/count-casts.ts            prints every assertion and `any`, exits 1 over budget

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const BUDGET = 5; // fewer than this
const SKIP = new Set(["node_modules", "dist", "logs", ".git"]);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

const assertions: Finding[] = [];
const anys: Finding[] = [];

for (const file of sources(ROOT)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const where = (): Finding => ({
      file: relative(ROOT, file),
      line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      text: node.getText().split("\n")[0] ?? "",
    });
    // `x as const` and `x satisfies T` are not assertions: they check, they do not override
    if (ts.isAsExpression(node) && !isConst(node.type)) assertions.push(where());
    if (ts.isTypeAssertionExpression(node)) assertions.push(where());
    if (node.kind === ts.SyntaxKind.AnyKeyword) anys.push(where());
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function isConst(type: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(type) && type.typeName.getText() === "const";
}

const show = (title: string, list: Finding[]): void => {
  console.log(`${title}: ${list.length}`);
  for (const f of list) console.log(`  ${f.file}:${f.line}  ${f.text}`);
};
show("type assertions (`as T`, not `as const`)", assertions);
show("explicit `any`", anys);

if (assertions.length >= BUDGET || anys.length > 0) {
  console.error(`over budget: need fewer than ${BUDGET} assertions and no \`any\``);
  process.exit(1);
}
