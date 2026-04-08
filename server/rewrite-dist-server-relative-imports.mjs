#!/usr/bin/env node

import path from 'node:path';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RELATIVE_SPECIFIER_EXTENSION_RE = /(?:\.[a-z0-9]+|\/index\.[a-z0-9]+)$/iu;
const STATIC_FROM_RE = /(\bfrom\s*)(["'])(\.{1,2}\/[^"'?#]+)([?#][^"']*)?\2/gu;
const SIDE_EFFECT_IMPORT_RE = /(\bimport\s*)(["'])(\.{1,2}\/[^"'?#]+)([?#][^"']*)?\2/gu;
const DYNAMIC_IMPORT_RE = /(\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'?#]+)([?#][^"']*)?\2(\s*\))/gu;
const DIST_SERVER_JS_SKIP_RE = /\.(?:benchmark|spec|test)\.js$/iu;

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function hasExplicitFileExtension(specifier) {
  return RELATIVE_SPECIFIER_EXTENSION_RE.test(specifier);
}

function splitSpecifier(specifier) {
  const hashIndex = specifier.indexOf('#');
  const queryIndex = specifier.indexOf('?');
  let suffixIndex = -1;

  if (queryIndex >= 0 && hashIndex >= 0) {
    suffixIndex = Math.min(queryIndex, hashIndex);
  } else if (queryIndex >= 0) {
    suffixIndex = queryIndex;
  } else if (hashIndex >= 0) {
    suffixIndex = hashIndex;
  }

  if (suffixIndex === -1) {
    return {
      pathPart: specifier,
      suffix: '',
    };
  }

  return {
    pathPart: specifier.slice(0, suffixIndex),
    suffix: specifier.slice(suffixIndex),
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRelativeImportSpecifier(filePath, specifier) {
  if (!isRelativeSpecifier(specifier) || hasExplicitFileExtension(specifier)) {
    return specifier;
  }

  const { pathPart, suffix } = splitSpecifier(specifier);
  const absoluteSpecifierPath = path.resolve(path.dirname(filePath), pathPart);
  if (await fileExists(`${absoluteSpecifierPath}.js`)) {
    return `${pathPart}.js${suffix}`;
  }

  if (await fileExists(path.join(absoluteSpecifierPath, 'index.js'))) {
    return `${pathPart}/index.js${suffix}`;
  }

  return specifier;
}

async function replaceSpecifierMatches(filePath, text, pattern, matchBuilder) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return {
      changed: false,
      text,
      unresolvedSpecifiers: [],
    };
  }

  const replacements = await Promise.all(
    matches.map(async (match) => {
      const specifier = match[3];
      if (!specifier) {
        throw new Error(`Expected relative import specifier in ${filePath}.`);
      }

      const suffix = match[4] ?? '';
      const rewrittenSpecifier = await resolveRelativeImportSpecifier(
        filePath,
        `${specifier}${suffix}`,
      );
      return {
        changed: rewrittenSpecifier !== `${specifier}${suffix}`,
        index: match.index ?? 0,
        length: match[0].length,
        replacement: matchBuilder(match, rewrittenSpecifier),
        unresolvedSpecifier:
          rewrittenSpecifier === `${specifier}${suffix}` && !hasExplicitFileExtension(specifier)
            ? `${specifier}${suffix}`
            : null,
      };
    }),
  );

  let rewrittenText = '';
  let cursor = 0;
  let changed = false;
  const unresolvedSpecifiers = [];

  for (const replacement of replacements) {
    rewrittenText += text.slice(cursor, replacement.index);
    rewrittenText += replacement.replacement;
    cursor = replacement.index + replacement.length;
    changed ||= replacement.changed;
    if (replacement.unresolvedSpecifier) {
      unresolvedSpecifiers.push(replacement.unresolvedSpecifier);
    }
  }

  rewrittenText += text.slice(cursor);

  return {
    changed,
    text: rewrittenText,
    unresolvedSpecifiers,
  };
}

export async function rewriteRelativeSpecifiers(filePath, text) {
  const staticPass = await replaceSpecifierMatches(
    filePath,
    text,
    STATIC_FROM_RE,
    (match, rewrittenSpecifier) => `${match[1]}${match[2]}${rewrittenSpecifier}${match[2]}`,
  );
  const sideEffectPass = await replaceSpecifierMatches(
    filePath,
    staticPass.text,
    SIDE_EFFECT_IMPORT_RE,
    (match, rewrittenSpecifier) => `${match[1]}${match[2]}${rewrittenSpecifier}${match[2]}`,
  );
  const dynamicPass = await replaceSpecifierMatches(
    filePath,
    sideEffectPass.text,
    DYNAMIC_IMPORT_RE,
    (match, rewrittenSpecifier) =>
      `${match[1]}${match[2]}${rewrittenSpecifier}${match[2]}${match[5] ?? ')'}`,
  );

  return {
    changed: staticPass.changed || sideEffectPass.changed || dynamicPass.changed,
    text: dynamicPass.text,
    unresolvedSpecifiers: [
      ...staticPass.unresolvedSpecifiers,
      ...sideEffectPass.unresolvedSpecifiers,
      ...dynamicPass.unresolvedSpecifiers,
    ],
  };
}

async function collectJavaScriptFiles(directoryPath) {
  const files = [];
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js') && !DIST_SERVER_JS_SKIP_RE.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function rewriteDistServerRelativeImports(options = {}) {
  const distServerDir = path.resolve(
    options.distServerDir ?? path.join(process.cwd(), 'dist-server'),
  );
  const javaScriptFiles = await collectJavaScriptFiles(distServerDir);
  let changedFileCount = 0;
  const unresolvedEntries = [];

  for (const filePath of javaScriptFiles) {
    const text = await readFile(filePath, 'utf8');
    const rewrittenFile = await rewriteRelativeSpecifiers(filePath, text);
    if (!rewrittenFile.changed) {
      if (rewrittenFile.unresolvedSpecifiers.length > 0) {
        unresolvedEntries.push({
          filePath,
          unresolvedSpecifiers: rewrittenFile.unresolvedSpecifiers,
        });
      }
      continue;
    }

    await writeFile(filePath, rewrittenFile.text, 'utf8');
    changedFileCount += 1;
    if (rewrittenFile.unresolvedSpecifiers.length > 0) {
      unresolvedEntries.push({
        filePath,
        unresolvedSpecifiers: rewrittenFile.unresolvedSpecifiers,
      });
    }
  }

  return {
    changedFileCount,
    distServerDir,
    scannedFileCount: javaScriptFiles.length,
    unresolvedEntries,
  };
}

async function main() {
  const result = await rewriteDistServerRelativeImports();
  if (result.unresolvedEntries.length > 0) {
    const unresolvedLines = result.unresolvedEntries.flatMap((entry) =>
      entry.unresolvedSpecifiers.map(
        (specifier) => `${path.relative(process.cwd(), entry.filePath)} -> ${specifier}`,
      ),
    );
    throw new Error(
      [
        'Failed to normalize one or more emitted dist-server relative imports.',
        ...unresolvedLines,
      ].join('\n'),
    );
  }

  console.warn(
    `[rewrite-dist-server-relative-imports] scanned ${result.scannedFileCount} files, rewrote ${result.changedFileCount}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
