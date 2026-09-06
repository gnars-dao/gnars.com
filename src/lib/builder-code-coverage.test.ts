import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) ? [file] : [];
  });
}

it("SDK wallet adapters cannot bypass Gnars transaction attribution (including /migrate)", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(path.resolve("src"))) {
    if (file.endsWith("/lib/builder-code-viem.ts")) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const rawAdapters = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      if (!["thirdweb/adapters", "thirdweb/adapters/viem"].includes(statement.moduleSpecifier.text))
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "viemAdapter")
          rawAdapters.add(element.name.text);
      }
    }
    function visit(node: ts.Node) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "toViem") {
        const adapter = node.expression;
        if (
          ts.isPropertyAccessExpression(adapter) &&
          ["wallet", "walletClient"].includes(adapter.name.text) &&
          ts.isIdentifier(adapter.expression) &&
          rawAdapters.has(adapter.expression.text)
        ) {
          violations.push(path.relative(process.cwd(), file));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations, "Use viemAdapter from @/lib/builder-code-viem for SDK writes").toEqual([]);
});
