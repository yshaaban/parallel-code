import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type BuildTarget = 'frontend' | 'remote' | 'server';

interface BuildArtifactConfig {
  checks: Record<BuildTarget, { sourceRelativePaths: string[] }>;
  ignoredSourceDirs: string[];
  ignoredSourceFilePatterns: string[];
}

const projectRoot = process.cwd();
const buildArtifactConfig = JSON.parse(
  readFileSync(path.join(projectRoot, 'server/build-artifacts-config.json'), 'utf8'),
) as BuildArtifactConfig;
const ignoredSourceDirs = new Set(buildArtifactConfig.ignoredSourceDirs);
const ignoredSourceFilePatterns = buildArtifactConfig.ignoredSourceFilePatterns.map(
  (pattern) => new RegExp(pattern, 'u'),
);

function toProjectRelative(filePath: string): string | null {
  const relativePath = path.relative(projectRoot, path.resolve(filePath));
  if (
    relativePath === '' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return relativePath.split(path.sep).join('/');
}

function isIgnoredBuildInput(relativePath: string): boolean {
  return (
    relativePath.split('/').some((segment) => ignoredSourceDirs.has(segment)) ||
    ignoredSourceFilePatterns.some((pattern) => pattern.test(relativePath))
  );
}

function isCoveredByConfiguredPath(relativePath: string, configuredPath: string): boolean {
  const normalizedPath = configuredPath.replace(/\/$/u, '');
  return relativePath === normalizedPath || relativePath.startsWith(`${normalizedPath}/`);
}

function assertBuildInputsCovered(target: BuildTarget, filePaths: Iterable<string>): void {
  const configuredPaths = buildArtifactConfig.checks[target].sourceRelativePaths;
  const relativePaths = [...filePaths]
    .map(toProjectRelative)
    .filter((relativePath): relativePath is string => relativePath !== null)
    .filter((relativePath) => !relativePath.startsWith('node_modules/'))
    .sort();
  const ignoredInputs = relativePaths.filter(isIgnoredBuildInput);
  const uncoveredInputs = relativePaths.filter(
    (relativePath) =>
      !configuredPaths.some((configuredPath) =>
        isCoveredByConfiguredPath(relativePath, configuredPath),
      ),
  );

  expect({ ignoredInputs, uncoveredInputs }).toEqual({
    ignoredInputs: [],
    uncoveredInputs: [],
  });
}

function readTypeScriptConfig(relativePath: string): ts.ParsedCommandLine {
  const configPath = path.join(projectRoot, relativePath);
  const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configResult.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configResult.error.messageText, '\n'));
  }

  return ts.parseJsonConfigFileContent(configResult.config, ts.sys, path.dirname(configPath));
}

function hasRuntimeImport(importDeclaration: ts.ImportDeclaration): boolean {
  const importClause = importDeclaration.importClause;
  if (!importClause) {
    return true;
  }
  if (importClause.isTypeOnly) {
    return false;
  }
  if (importClause.name || !importClause.namedBindings) {
    return true;
  }
  if (ts.isNamespaceImport(importClause.namedBindings)) {
    return true;
  }

  return importClause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function hasRuntimeExport(exportDeclaration: ts.ExportDeclaration): boolean {
  if (exportDeclaration.isTypeOnly) {
    return false;
  }
  if (!exportDeclaration.exportClause || ts.isNamespaceExport(exportDeclaration.exportClause)) {
    return true;
  }

  return exportDeclaration.exportClause.elements.some((element) => !element.isTypeOnly);
}

function getRuntimeModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      hasRuntimeImport(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      hasRuntimeExport(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

function collectViteRuntimeInputs(
  entryRelativePath: string,
  compilerOptions: ts.CompilerOptions,
): Set<string> {
  const pending = [path.join(projectRoot, entryRelativePath)];
  const inputs = new Set<string>();

  while (pending.length > 0) {
    const filePath = path.resolve(pending.pop() as string);
    if (inputs.has(filePath)) {
      continue;
    }
    inputs.add(filePath);

    if (!/\.[cm]?[jt]sx?$/u.test(filePath)) {
      continue;
    }

    const source = readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    for (const specifier of getRuntimeModuleSpecifiers(sourceFile)) {
      const resolvedModule = ts.resolveModuleName(
        specifier,
        filePath,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (!resolvedModule) {
        continue;
      }

      const resolvedPath = path.resolve(resolvedModule.resolvedFileName);
      const projectRelativePath = toProjectRelative(resolvedPath);
      if (projectRelativePath && !projectRelativePath.startsWith('node_modules/')) {
        pending.push(resolvedPath);
      }
    }
  }

  return inputs;
}

describe('build artifact source boundaries', () => {
  it('references source paths that still exist', () => {
    const missingPaths = (Object.keys(buildArtifactConfig.checks) as BuildTarget[]).flatMap(
      (target) =>
        buildArtifactConfig.checks[target].sourceRelativePaths
          .filter((relativePath) => !existsSync(path.join(projectRoot, relativePath)))
          .map((relativePath) => `${target}: ${relativePath}`),
    );

    expect(missingPaths).toEqual([]);
  });

  it.each([
    ['frontend', 'src/index.tsx'],
    ['remote', 'src/remote/index.tsx'],
  ] as const)('covers the %s Vite runtime import closure', (target, entryRelativePath) => {
    const compilerOptions = readTypeScriptConfig('tsconfig.json').options;
    assertBuildInputsCovered(target, collectViteRuntimeInputs(entryRelativePath, compilerOptions));
  });

  it('covers every production TypeScript server input', () => {
    const parsedConfig = readTypeScriptConfig('server/tsconfig.build.json');
    const program = ts.createProgram({
      options: parsedConfig.options,
      rootNames: parsedConfig.fileNames,
    });

    assertBuildInputsCovered(
      'server',
      program.getSourceFiles().map((sourceFile) => sourceFile.fileName),
    );
  });
});
