/** Folder name from a project name: trim, drop path separators ('/'),
 *  collapse internal whitespace to '-', keep unicode (Chinese ok). */
export function sanitizeFolderName(name: string): string {
  return name
    .trim()
    .replace(/[/]/g, "")
    .replace(/\s+/g, "-");
}

/** Suggested absolute repoPath = <root>/<slug>. Empty if either is missing. */
export function suggestRepoPath(root: string | null | undefined, name: string): string {
  const slug = sanitizeFolderName(name);
  if (!root || !slug) return "";
  return root.replace(/\/+$/, "") + "/" + slug;
}
