export interface RewriteDistServerRelativeImportsResult {
  changedFileCount: number;
  distServerDir: string;
  scannedFileCount: number;
  unresolvedEntries: Array<{
    filePath: string;
    unresolvedSpecifiers: string[];
  }>;
}

export function resolveRelativeImportSpecifier(
  filePath: string,
  specifier: string,
): Promise<string>;

export function rewriteRelativeSpecifiers(
  filePath: string,
  text: string,
): Promise<{
  changed: boolean;
  text: string;
  unresolvedSpecifiers: string[];
}>;

export function rewriteDistServerRelativeImports(options?: {
  distServerDir?: string;
}): Promise<RewriteDistServerRelativeImportsResult>;
