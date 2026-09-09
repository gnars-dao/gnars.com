import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT_NAMESPACES, ROUTE_NAMESPACES, selectMessages } from "./client-messages";

const sourceRoot = path.resolve("src");
const routeRoot = path.join(sourceRoot, "app/[locale]");

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

// Follow local imports, including lazy dialogs, to protect shared component messages.
function clientNamespaces(file: string, seen = new Set<string>()): Set<string> {
  const namespaces = new Set<string>();
  if (seen.has(file)) return namespaces;
  seen.add(file);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  function follow(specifier: string) {
    const base = specifier.startsWith("@/")
      ? path.join(sourceRoot, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : null;
    if (!base) return;
    const target = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (target && /\.[jt]sx?$/.test(target)) {
      for (const namespace of clientNamespaces(target, seen)) namespaces.add(namespace);
    }
  }

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      follow(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteral(arg))
        follow(arg.text);
      if (ts.isIdentifier(node.expression) && node.expression.text === "useTranslations") {
        if (!arg || !ts.isStringLiteral(arg))
          throw new Error(`Unscoped client translator in ${file}`);
        namespaces.add(arg.text.split(".")[0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return namespaces;
}

describe("client translation delivery", () => {
  it("provides every namespace needed by the global shell", () => {
    const missing = [...clientNamespaces(path.join(routeRoot, "layout.tsx"))].filter(
      (namespace) => !(ROOT_NAMESPACES as readonly string[]).includes(namespace),
    );
    expect(missing).toEqual([]);
  });

  for (const entry of readdirSync(routeRoot, { withFileTypes: true })) {
    const route = entry.isDirectory() ? entry.name : entry.name === "page.tsx" ? "home" : null;
    if (!route) continue;
    it(`covers client translations in /${route}`, () => {
      const files =
        route === "home"
          ? [path.join(routeRoot, "page.tsx")]
          : filesIn(path.join(routeRoot, route)).filter((file) =>
              /\/(page|layout|error|not-found|loading)\.tsx$/.test(file),
            );
      const additions = ROUTE_NAMESPACES[route as keyof typeof ROUTE_NAMESPACES] ?? [];
      const available = new Set<string>([...ROOT_NAMESPACES, ...additions]);
      const required = new Set(files.flatMap((file) => [...clientNamespaces(file)]));
      expect([...required].filter((namespace) => !available.has(namespace))).toEqual([]);
      if (additions.length) {
        const providerFile = path.join(
          routeRoot,
          route === "home" ? "page.tsx" : `${route}/layout.tsx`,
        );
        expect(readFileSync(providerFile, "utf8")).toContain(`route="${route}"`);
      }
    });
  }

  it.each(["en", "pt-br"])("has all selected messages in %s", (locale) => {
    const messages = Object.fromEntries(
      readdirSync(`messages/${locale}`)
        .filter((file) => file.endsWith(".json"))
        .map((file) => [
          file.slice(0, -5),
          JSON.parse(readFileSync(`messages/${locale}/${file}`, "utf8")),
        ]),
    );
    expect(Object.keys(selectMessages(messages, ROOT_NAMESPACES))).toEqual([...ROOT_NAMESPACES]);
    for (const namespaces of Object.values(ROUTE_NAMESPACES)) {
      expect(Object.keys(selectMessages(messages, namespaces))).toEqual([...namespaces]);
    }
  });
});
