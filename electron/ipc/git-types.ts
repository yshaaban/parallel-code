export interface GitChangedFile {
  path: string;
  lines_added: number;
  lines_removed: number;
  status: string;
  committed: boolean;
}

export interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

export interface ProjectDiffResult {
  files: GitChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}
