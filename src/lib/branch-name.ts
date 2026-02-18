export function toBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/--+/g, "-");
}

export function sanitizeBranchPrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const parts = normalized
    .split("/")
    .map((segment) => toBranchName(segment))
    .filter((segment) => segment.length > 0);
  return parts.join("/") || "task";
}
