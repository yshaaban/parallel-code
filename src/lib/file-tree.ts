import type { ChangedFile } from '../ipc/types';

export interface FileTreeFileNode {
  children?: never;
  file: ChangedFile;
  fileCount?: never;
  kind: 'file';
  linesAdded?: never;
  linesRemoved?: never;
  name: string;
  path: string;
}

export interface FileTreeDirectoryNode {
  children: ReadonlyArray<FileTreeNode>;
  file?: never;
  fileCount: number;
  kind: 'dir';
  linesAdded: number;
  linesRemoved: number;
  name: string;
  path: string;
}

export type FileTreeNode = FileTreeFileNode | FileTreeDirectoryNode;

export interface FileTreeRow {
  depth: number;
  isDir: boolean;
  node: FileTreeNode;
}

interface WorkingFileNode {
  file: ChangedFile;
  kind: 'file';
  name: string;
  path: string;
}

interface WorkingDirectoryNode {
  children: Map<string, WorkingTreeNode>;
  kind: 'dir';
  name: string;
  path: string;
}

type WorkingTreeNode = WorkingDirectoryNode | WorkingFileNode;

function normalizeTreePath(filePath: string): string {
  return filePath.replace(/\/+$/, '');
}

function splitTreePath(filePath: string): string[] {
  return normalizeTreePath(filePath)
    .split('/')
    .filter((segment) => segment.length > 0);
}

function createDirectoryNode(name: string, path: string): WorkingDirectoryNode {
  return {
    children: new Map<string, WorkingTreeNode>(),
    kind: 'dir',
    name,
    path,
  };
}

function createFileNode(name: string, path: string, file: ChangedFile): WorkingFileNode {
  return {
    file,
    kind: 'file',
    name,
    path,
  };
}

function compareTreeNodes(left: WorkingTreeNode, right: WorkingTreeNode): number {
  if (left.kind !== right.kind) {
    return left.kind === 'dir' ? -1 : 1;
  }

  return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
}

function insertFileNode(
  children: Map<string, WorkingTreeNode>,
  pathSegments: ReadonlyArray<string>,
  file: ChangedFile,
  segmentIndex: number,
  parentPath: string,
): void {
  const segmentName = pathSegments[segmentIndex];
  if (segmentName === undefined) {
    return;
  }

  const nextPath = parentPath ? `${parentPath}/${segmentName}` : segmentName;
  const isLeaf = segmentIndex === pathSegments.length - 1;

  if (isLeaf) {
    children.set(segmentName, createFileNode(segmentName, nextPath, file));
    return;
  }

  const currentNode = children.get(segmentName);
  const directoryNode =
    currentNode?.kind === 'dir' ? currentNode : createDirectoryNode(segmentName, nextPath);
  children.set(segmentName, directoryNode);

  insertFileNode(directoryNode.children, pathSegments, file, segmentIndex + 1, nextPath);
}

function finalizeNodes(children: Map<string, WorkingTreeNode>): ReadonlyArray<FileTreeNode> {
  const finalizedChildren = Array.from(children.values()).sort(compareTreeNodes);
  return finalizedChildren.map(finalizeNode);
}

function finalizeNode(node: WorkingTreeNode): FileTreeNode {
  if (node.kind === 'file') {
    return {
      file: node.file,
      kind: 'file',
      name: node.name,
      path: node.path,
    };
  }

  const children = finalizeNodes(node.children);
  let fileCount = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const child of children) {
    if (child.kind === 'file') {
      fileCount += 1;
      linesAdded += child.file.lines_added;
      linesRemoved += child.file.lines_removed;
      continue;
    }

    fileCount += child.fileCount;
    linesAdded += child.linesAdded;
    linesRemoved += child.linesRemoved;
  }

  return {
    children,
    fileCount,
    kind: 'dir',
    linesAdded,
    linesRemoved,
    name: node.name,
    path: node.path,
  };
}

export function buildFileTree(files: ReadonlyArray<ChangedFile>): ReadonlyArray<FileTreeNode> {
  const root = new Map<string, WorkingTreeNode>();

  for (const file of files) {
    const pathSegments = splitTreePath(file.path);
    if (pathSegments.length === 0) {
      continue;
    }

    insertFileNode(root, pathSegments, file, 0, '');
  }

  return finalizeNodes(root);
}

export function flattenVisibleTree(
  tree: ReadonlyArray<FileTreeNode>,
  collapsedPaths: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];

  function walk(nodes: ReadonlyArray<FileTreeNode>, depth: number): void {
    for (const node of nodes) {
      rows.push({
        depth,
        isDir: node.kind === 'dir',
        node,
      });

      if (node.kind === 'dir' && !collapsedPaths.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  }

  walk(tree, 0);
  return rows;
}
