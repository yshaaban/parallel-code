import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RENDERER_BUNDLED_DEPENDENCY_NAMES } from '../scripts/lib/dependency-exposure.mjs';

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
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const ignoredSourceDirs = new Set(buildArtifactConfig.ignoredSourceDirs);
const ignoredSourceFilePatterns = buildArtifactConfig.ignoredSourceFilePatterns.map(
  (pattern) => new RegExp(pattern, 'u'),
);

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

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
    const isRequireResolve =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'require' &&
      node.expression.name.text === 'resolve';
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        isRequireResolve)
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(
          `Non-literal runtime module load in ${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`,
        );
      }
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

function resolveRuntimeModule(
  specifier: string,
  filePath: string,
  compilerOptions: ts.CompilerOptions,
): ts.ResolvedModuleFull {
  const resolvableSpecifier = specifier.split(/[?#]/u, 1)[0];
  if (!resolvableSpecifier) {
    throw new Error(
      `Could not resolve runtime import ${JSON.stringify(specifier)} from ${filePath}`,
    );
  }
  const resolvedModule = ts.resolveModuleName(
    resolvableSpecifier,
    filePath,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (resolvedModule) return resolvedModule;

  try {
    return {
      extension: ts.Extension.Js,
      isExternalLibraryImport: true,
      resolvedFileName: createRequire(filePath).resolve(resolvableSpecifier),
    };
  } catch {
    const isRelativeSpecifier = resolvableSpecifier.startsWith('.');
    const isBareSpecifier =
      !isRelativeSpecifier &&
      !path.isAbsolute(resolvableSpecifier) &&
      !/^[a-z][a-z\d+.-]*:/iu.test(resolvableSpecifier);
    const fallbackBase = isRelativeSpecifier
      ? path.resolve(path.dirname(filePath), resolvableSpecifier)
      : isBareSpecifier
        ? path.join(projectRoot, 'node_modules', resolvableSpecifier)
        : null;
    if (!fallbackBase) {
      throw new Error(
        `Could not resolve runtime import ${JSON.stringify(specifier)} from ${filePath}`,
      );
    }
    if (isBareSpecifier) {
      const relativeToNodeModules = path.relative(
        path.join(projectRoot, 'node_modules'),
        fallbackBase,
      );
      if (
        relativeToNodeModules === '..' ||
        relativeToNodeModules.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToNodeModules)
      ) {
        throw new Error(
          `Could not resolve runtime import ${JSON.stringify(specifier)} from ${filePath}`,
        );
      }
    }
    const directPackageCandidates = ['', '.js', '.mjs', '.cjs', '.css'].map(
      (extension) => `${fallbackBase}${extension}`,
    );
    const directPackagePath = directPackageCandidates.find((candidate) => existsSync(candidate));
    if (directPackagePath) {
      return {
        extension: ts.Extension.Js,
        isExternalLibraryImport: true,
        resolvedFileName: directPackagePath,
      };
    }
    throw new Error(
      `Could not resolve runtime import ${JSON.stringify(specifier)} from ${filePath}`,
    );
  }
}

function getNodeModulesPackageName(relativePath: string): string {
  const segments = relativePath.split('/');
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  const firstNameSegment = segments[nodeModulesIndex + 1];
  if (!firstNameSegment) throw new Error(`Invalid node_modules path: ${relativePath}`);
  if (!firstNameSegment.startsWith('@')) return firstNameSegment;
  const secondNameSegment = segments[nodeModulesIndex + 2];
  if (!secondNameSegment) throw new Error(`Invalid scoped node_modules path: ${relativePath}`);
  return `${firstNameSegment}/${secondNameSegment}`;
}

function getImportedPackageRoot(specifier: string, resolvedRelativePath: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    if (scope && name) return `${scope}/${name}`;
  } else {
    const [name] = specifier.split('/');
    if (name) return name;
  }
  return getNodeModulesPackageName(resolvedRelativePath);
}

function collectViteRuntimeClosure(
  entryRelativePath: string,
  compilerOptions: ts.CompilerOptions,
): { externalPackageRoots: Set<string>; inputs: Set<string> } {
  const pending = [path.join(projectRoot, entryRelativePath)];
  const inputs = new Set<string>();
  const externalPackageRoots = new Set<string>();

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
      const resolvedModule = resolveRuntimeModule(specifier, filePath, compilerOptions);

      const resolvedPath = path.resolve(resolvedModule.resolvedFileName);
      const projectRelativePath = toProjectRelative(resolvedPath);
      if (projectRelativePath?.startsWith('node_modules/')) {
        externalPackageRoots.add(getImportedPackageRoot(specifier, projectRelativePath));
      } else if (projectRelativePath) {
        pending.push(resolvedPath);
      } else {
        throw new Error(
          `Runtime import ${JSON.stringify(specifier)} from ${filePath} resolves outside the project root.`,
        );
      }
    }
  }

  return { externalPackageRoots, inputs };
}

describe('build artifact source boundaries', () => {
  it('fails closed for unresolved and non-literal runtime module loads', () => {
    const sourceFile = ts.createSourceFile(
      '/fixture.ts',
      "const packageName = 'renderer'; import(packageName);",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(() => getRuntimeModuleSpecifiers(sourceFile)).toThrow(
      'Non-literal runtime module load in /fixture.ts:1:',
    );
    const requireResolveSource = ts.createSourceFile(
      '/fixture.ts',
      'require.resolve(packageName);',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(() => getRuntimeModuleSpecifiers(requireResolveSource)).toThrow(
      'Non-literal runtime module load in /fixture.ts:1:',
    );
    expect(() =>
      resolveRuntimeModule(
        '__parallel_code_missing_runtime_dependency__',
        path.join(projectRoot, 'src/index.tsx'),
        readTypeScriptConfig('tsconfig.json').options,
      ),
    ).toThrow('Could not resolve runtime import');
  });

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
    assertBuildInputsCovered(
      target,
      collectViteRuntimeClosure(entryRelativePath, compilerOptions).inputs,
    );
  });

  it('keeps shipped renderer dependency roots aligned with Vite runtime imports', () => {
    const compilerOptions = readTypeScriptConfig('tsconfig.json').options;
    const runtimeRoots = new Set(
      ['src/index.tsx', 'src/remote/index.tsx'].flatMap((entryRelativePath) => [
        ...collectViteRuntimeClosure(entryRelativePath, compilerOptions).externalPackageRoots,
      ]),
    );
    const dependencies = packageJson.dependencies ?? {};
    const devDependencies = packageJson.devDependencies ?? {};
    const unknownRoots = [...runtimeRoots]
      .filter(
        (dependencyName) =>
          !hasOwn(dependencies, dependencyName) && !hasOwn(devDependencies, dependencyName),
      )
      .sort();
    const rendererOnlyRoots = [...runtimeRoots]
      .filter((dependencyName) => hasOwn(devDependencies, dependencyName))
      .sort();

    expect({
      unknownRoots,
      rendererOnlyRoots,
      policyRoots: [...RENDERER_BUNDLED_DEPENDENCY_NAMES].sort(),
    }).toEqual({
      unknownRoots: [],
      rendererOnlyRoots: [...RENDERER_BUNDLED_DEPENDENCY_NAMES].sort(),
      policyRoots: [...RENDERER_BUNDLED_DEPENDENCY_NAMES].sort(),
    });
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

  it('keeps test, helper, specification, and benchmark modules out of server emission', () => {
    const parsedConfig = readTypeScriptConfig('server/tsconfig.build.json');
    const emittedNonProductionInputs = parsedConfig.fileNames
      .map((fileName) => toProjectRelative(fileName))
      .filter((fileName): fileName is string => fileName !== null)
      .filter((fileName) => /\.(?:benchmark|spec|test|test-helper)\.[cm]?[jt]sx?$/u.test(fileName));

    expect(emittedNonProductionInputs).toEqual([]);
  });
});
