const EXPOSURE_LANES = /** @type {const} */ (['backend-runtime', 'renderer-shipped', 'tooling']);

export const RENDERER_BUNDLED_DEPENDENCY_NAMES = Object.freeze([
  '@xterm/addon-fit',
  '@xterm/addon-search',
  '@xterm/addon-web-links',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'marked',
  'mermaid',
  'monaco-editor',
  'qrcode',
  'shiki',
  'solid-js',
]);

export const DEPENDENCY_EXPOSURE_LANES = EXPOSURE_LANES;

const EXPOSURE_PRECEDENCE = new Map(EXPOSURE_LANES.map((lane, index) => [lane, index]));

function assertPlainRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function normalizeDependencyMap(value, label) {
  if (value === undefined) return {};
  return assertPlainRecord(value, label);
}

export function getLockPackageName(packagePath) {
  const marker = 'node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Lock package path is not a node_modules entry: ${packagePath}`);
  }

  const packageName = packagePath.slice(markerIndex + marker.length);
  if (!packageName || packageName.includes('/node_modules/')) {
    throw new Error(`Lock package path has an invalid package name: ${packagePath}`);
  }
  return packageName;
}

function getParentPackagePath(packagePath) {
  const nestedMarkerIndex = packagePath.lastIndexOf('/node_modules/');
  return nestedMarkerIndex < 0 ? '' : packagePath.slice(0, nestedMarkerIndex);
}

function resolveInstalledDependency(packages, parentPackagePath, dependencyName) {
  let candidateParent = parentPackagePath;

  while (true) {
    const candidatePath = candidateParent
      ? `${candidateParent}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidatePath)) {
      return candidatePath;
    }
    if (!candidateParent) return null;
    candidateParent = getParentPackagePath(candidateParent);
  }
}

function getDependencyEdges(metadata, packagePath) {
  const requiredDependencies = normalizeDependencyMap(
    metadata.dependencies,
    `${packagePath || 'root'} dependencies`,
  );
  const optionalDependencies = normalizeDependencyMap(
    metadata.optionalDependencies,
    `${packagePath || 'root'} optionalDependencies`,
  );
  const peerDependencies = normalizeDependencyMap(
    metadata.peerDependencies,
    `${packagePath || 'root'} peerDependencies`,
  );
  const peerDependenciesMeta = normalizeDependencyMap(
    metadata.peerDependenciesMeta,
    `${packagePath || 'root'} peerDependenciesMeta`,
  );
  const edges = new Map();

  for (const dependencyName of Object.keys(requiredDependencies)) {
    edges.set(dependencyName, { optional: false });
  }
  for (const dependencyName of Object.keys(optionalDependencies)) {
    // npm treats an optionalDependencies declaration as authoritative when the
    // same name also appears in dependencies. A missing platform-specific
    // install must therefore remain optional instead of becoming a dangling
    // required edge in the classifier.
    edges.set(dependencyName, { optional: true });
  }
  for (const dependencyName of Object.keys(peerDependencies)) {
    if (edges.has(dependencyName)) continue;
    const peerMeta = peerDependenciesMeta[dependencyName];
    const optional =
      peerMeta !== undefined &&
      peerMeta !== null &&
      typeof peerMeta === 'object' &&
      !Array.isArray(peerMeta) &&
      peerMeta.optional === true;
    edges.set(dependencyName, { optional });
  }

  return [...edges.entries()]
    .map(([name, edge]) => ({ name, ...edge }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function validatePackageNode(packagePath, metadata) {
  assertPlainRecord(metadata, `Lock package ${packagePath}`);
  const installName = getLockPackageName(packagePath);
  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error(`Lock package ${packagePath} is missing a version.`);
  }
  if (
    metadata.name !== undefined &&
    (typeof metadata.name !== 'string' || metadata.name.length === 0)
  ) {
    throw new Error(`Lock package ${packagePath} declares an invalid package name.`);
  }
  return {
    installName,
    name: metadata.name ?? installName,
    version: metadata.version,
  };
}

function traverseLane({ packages, lane, roots, membershipsByNode }) {
  const queue = [];

  for (const root of [...roots].sort((left, right) => left.name.localeCompare(right.name))) {
    const nodePath = resolveInstalledDependency(packages, '', root.name);
    if (!nodePath) {
      if (root.optional) continue;
      throw new Error(`Missing ${lane} dependency root: ${root.name}`);
    }
    queue.push({ nodePath, path: [nodePath] });
  }

  const visited = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (visited.has(item.nodePath)) continue;
    visited.add(item.nodePath);

    const metadata = packages[item.nodePath];
    validatePackageNode(item.nodePath, metadata);
    const memberships = membershipsByNode.get(item.nodePath) ?? new Map();
    memberships.set(lane, Object.freeze([...item.path]));
    membershipsByNode.set(item.nodePath, memberships);

    for (const edge of getDependencyEdges(metadata, item.nodePath)) {
      const dependencyPath = resolveInstalledDependency(packages, item.nodePath, edge.name);
      if (!dependencyPath) {
        if (edge.optional) continue;
        throw new Error(`Dangling dependency edge: ${item.nodePath} -> ${edge.name}`);
      }
      queue.push({ nodePath: dependencyPath, path: [...item.path, dependencyPath] });
    }
  }
}

export function classifyDependencyExposure(
  packageLock,
  { rendererRoots = RENDERER_BUNDLED_DEPENDENCY_NAMES } = {},
) {
  if (packageLock?.lockfileVersion !== 3) {
    throw new Error(
      `package-lock lockfileVersion must be 3, received ${String(packageLock?.lockfileVersion)}.`,
    );
  }
  const packages = assertPlainRecord(packageLock?.packages, 'package-lock packages');
  const root = assertPlainRecord(packages[''], 'package-lock root package');
  const backendRoots = Object.keys(normalizeDependencyMap(root.dependencies, 'root dependencies'));
  const optionalBackendRoots = Object.keys(
    normalizeDependencyMap(root.optionalDependencies, 'root optionalDependencies'),
  );
  const developmentRoots = Object.keys(
    normalizeDependencyMap(root.devDependencies, 'root devDependencies'),
  );
  const backendRootMap = new Map(backendRoots.map((name) => [name, { name, optional: false }]));
  for (const name of optionalBackendRoots) {
    backendRootMap.set(name, { name, optional: true });
  }
  const developmentRootSet = new Set(developmentRoots);

  for (const rendererRoot of rendererRoots) {
    if (!developmentRootSet.has(rendererRoot)) {
      throw new Error(`Renderer dependency root is not a devDependency: ${rendererRoot}`);
    }
    if (backendRoots.includes(rendererRoot) || optionalBackendRoots.includes(rendererRoot)) {
      throw new Error(`Renderer dependency root is also a backend dependency: ${rendererRoot}`);
    }
  }

  const membershipsByNode = new Map();
  traverseLane({
    packages,
    lane: 'backend-runtime',
    roots: backendRootMap.values(),
    membershipsByNode,
  });
  traverseLane({
    packages,
    lane: 'renderer-shipped',
    roots: [...new Set(rendererRoots)].map((name) => ({ name, optional: false })),
    membershipsByNode,
  });
  traverseLane({
    packages,
    lane: 'tooling',
    roots: [...new Set(developmentRoots)].map((name) => ({ name, optional: false })),
    membershipsByNode,
  });

  const nodes = Object.entries(packages)
    .filter(([packagePath]) => packagePath.includes('node_modules/'))
    .map(([nodePath, metadata]) => {
      const identity = validatePackageNode(nodePath, metadata);
      const membershipMap = membershipsByNode.get(nodePath);
      if (!membershipMap || membershipMap.size === 0) {
        throw new Error(
          `Installed lock package is not reachable from a declared root: ${nodePath}`,
        );
      }
      const memberships = [...membershipMap.entries()]
        .map(([lane, dependencyPath]) => ({ lane, dependencyPath }))
        .sort(
          (left, right) => EXPOSURE_PRECEDENCE.get(left.lane) - EXPOSURE_PRECEDENCE.get(right.lane),
        );
      return Object.freeze({
        nodePath,
        ...identity,
        primaryExposure: memberships[0].lane,
        memberships: Object.freeze(memberships),
      });
    })
    .sort((left, right) => left.nodePath.localeCompare(right.nodePath));

  return Object.freeze({
    nodes: Object.freeze(nodes),
    nodesByPath: new Map(nodes.map((node) => [node.nodePath, node])),
  });
}

export function normalizeAuditNodePath(nodePath) {
  if (typeof nodePath !== 'string' || nodePath.length === 0) {
    throw new Error('Audit node path must be a non-empty string.');
  }
  return nodePath.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
}
