import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

// Build-time precompression for the browser-served bundles. Writes .gz and
// .br siblings next to compressible assets so server/browser-static.ts can
// serve them with Content-Encoding. `--check` is the CI byte-budget gate: it
// asserts the siblings exist, the gzipped main bundle stays under budget, and
// dist/index.html carries the terminal-session modulepreload link.

const gzip = promisify(zlib.gzip);
const brotliCompress = promisify(zlib.brotliCompress);

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');

const DIST_DIRS = ['dist', 'dist-remote'];
const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.css', '.svg', '.html', '.json', '.map']);
const MIN_COMPRESSIBLE_BYTES = 1024;
const MAIN_BUNDLE_GZIP_BUDGET_BYTES = 250 * 1024;

async function listFilesRecursively(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function isCompressibleFile(filePath, sizeBytes) {
  const extension = path.extname(filePath).toLowerCase();
  return COMPRESSIBLE_EXTENSIONS.has(extension) && sizeBytes > MIN_COMPRESSIBLE_BYTES;
}

async function collectCompressibleFiles(distDir) {
  const compressible = [];
  let allFiles;
  try {
    allFiles = await listFilesRecursively(distDir);
  } catch {
    return compressible;
  }

  for (const filePath of allFiles) {
    if (filePath.endsWith('.gz') || filePath.endsWith('.br')) {
      continue;
    }

    const stat = await fs.stat(filePath);
    if (isCompressibleFile(filePath, stat.size)) {
      compressible.push({ path: filePath, size: stat.size });
    }
  }

  return compressible;
}

async function compressFile(filePath) {
  const contents = await fs.readFile(filePath);
  const [gzipped, brotlied] = await Promise.all([
    gzip(contents, { level: 9 }),
    brotliCompress(contents, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length,
      },
    }),
  ]);
  await Promise.all([
    fs.writeFile(`${filePath}.gz`, gzipped),
    fs.writeFile(`${filePath}.br`, brotlied),
  ]);
  return { brotliBytes: brotlied.length, gzipBytes: gzipped.length };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCompress() {
  let compressedCount = 0;
  for (const distDirName of DIST_DIRS) {
    const distDir = path.join(projectRoot, distDirName);
    const files = await collectCompressibleFiles(distDir);
    for (const file of files) {
      await compressFile(file.path);
      compressedCount += 1;
    }
  }
  process.stdout.write(`Precompressed ${compressedCount} assets (.gz + .br siblings)\n`);
}

async function runCheck() {
  const failures = [];

  for (const distDirName of DIST_DIRS) {
    const distDir = path.join(projectRoot, distDirName);
    const files = await collectCompressibleFiles(distDir);
    for (const file of files) {
      if (!(await fileExists(`${file.path}.gz`)) || !(await fileExists(`${file.path}.br`))) {
        failures.push(
          `missing precompressed siblings for ${path.relative(projectRoot, file.path)}`,
        );
      }
    }
  }

  const distAssetsDir = path.join(projectRoot, 'dist', 'assets');
  let assetNames = [];
  try {
    assetNames = await fs.readdir(distAssetsDir);
  } catch {
    failures.push('dist/assets is missing; build the frontend first');
  }

  const mainBundleNames = assetNames.filter(
    (name) => /^index-[^.]+\.js$/.test(name) && !name.endsWith('.gz') && !name.endsWith('.br'),
  );
  if (mainBundleNames.length === 0) {
    failures.push('no main index-*.js bundle found in dist/assets');
  }
  for (const name of mainBundleNames) {
    const gzPath = path.join(distAssetsDir, `${name}.gz`);
    if (!(await fileExists(gzPath))) {
      failures.push(`missing gzip sibling for dist/assets/${name}`);
      continue;
    }

    const gzStat = await fs.stat(gzPath);
    if (gzStat.size >= MAIN_BUNDLE_GZIP_BUDGET_BYTES) {
      failures.push(
        `dist/assets/${name}.gz is ${gzStat.size} bytes; budget is < ${MAIN_BUNDLE_GZIP_BUDGET_BYTES}`,
      );
    } else {
      process.stdout.write(
        `main bundle ${name}: gzip ${gzStat.size} bytes (budget ${MAIN_BUNDLE_GZIP_BUDGET_BYTES})\n`,
      );
    }
  }

  const indexHtmlPath = path.join(projectRoot, 'dist', 'index.html');
  let indexHtml = '';
  try {
    indexHtml = await fs.readFile(indexHtmlPath, 'utf8');
  } catch {
    failures.push('dist/index.html is missing; build the frontend first');
  }
  if (indexHtml) {
    const linkTags = indexHtml.match(/<link\b[^>]*>/g) ?? [];
    const hasTerminalSessionPreload = linkTags.some(
      (tag) =>
        tag.includes('rel="modulepreload"') &&
        /href="\.\/assets\/terminal-session-[^"]+\.js"/.test(tag),
    );
    if (!hasTerminalSessionPreload) {
      failures.push('dist/index.html is missing the terminal-session modulepreload link');
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`compress-dist-assets check failed: ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('compress-dist-assets check passed\n');
}

const isCheckMode = process.argv.includes('--check');
await (isCheckMode ? runCheck() : runCompress());
