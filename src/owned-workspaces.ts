import fs from "node:fs";
import path from "node:path";

export class WorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConfigError";
  }
}

function accessibleDirectory(requested: string, label: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(requested);
    if (!fs.statSync(canonical).isDirectory()) throw new Error("not a directory");
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    throw new WorkspaceConfigError(`${label} is not an accessible directory: ${requested}`);
  }
  return canonical;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function parseWorkspaceRoots(raw: string | undefined, startupCwd: string = process.cwd()): string[] {
  if (!raw?.trim()) {
    return [accessibleDirectory(startupCwd, "Launch directory")];
  }
  const roots: string[] = [];
  for (const entry of raw.split(path.delimiter)) {
    const value = entry.trim();
    if (!value) continue;
    if (!path.isAbsolute(value)) {
      throw new WorkspaceConfigError(`WORKSPACE_ROOTS entries must be absolute: ${value}`);
    }
    const canonical = accessibleDirectory(value, "Workspace root");
    if (!roots.includes(canonical)) roots.push(canonical);
  }
  if (!roots.length) throw new WorkspaceConfigError("WORKSPACE_ROOTS must contain at least one directory.");
  return roots;
}

export class OwnedWorkspaceCatalog {
  private readonly recent = new Map<string, number>();
  private sequence = 0;

  constructor(readonly roots: string[]) {}

  choices(limit = 4): string[] {
    const candidates = new Set<string>();
    for (const candidate of this.recent.keys()) {
      try {
        candidates.add(this.validate(candidate));
      } catch {
        // Remembered directories can disappear between launches.
      }
    }
    for (const root of this.roots) {
      candidates.add(root);
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const requested = path.join(root, entry.name);
        try {
          const canonical = accessibleDirectory(requested, "Workspace");
          if (this.approved(canonical)) candidates.add(canonical);
        } catch {
          // Races, broken links, and inaccessible children are simply not offered.
        }
      }
    }
    return [...candidates]
      .map((candidate) => ({
        candidate,
        recent: this.recent.get(candidate) ?? 0,
        modified: this.modifiedAt(candidate),
      }))
      .sort((a, b) => b.recent - a.recent || b.modified - a.modified || a.candidate.localeCompare(b.candidate))
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.candidate);
  }

  resolve(answer: string, displayed: string[] = this.choices()): string {
    const value = answer.trim();
    if (!value) throw new WorkspaceConfigError("Choose a working directory.");

    const shown = displayed.find((candidate) => candidate === value);
    if (shown) return this.validate(shown);
    if (path.isAbsolute(value)) return this.validate(value);

    const matches = new Set<string>();
    for (const root of this.roots) {
      try {
        matches.add(this.validate(path.resolve(root, value)));
      } catch {
        // The relative answer need only resolve under one configured root.
      }
    }
    if (matches.size === 1) return [...matches][0];
    if (matches.size > 1) {
      throw new WorkspaceConfigError(`Working directory is ambiguous across WORKSPACE_ROOTS: ${value}`);
    }
    throw new WorkspaceConfigError(`Working directory is not an approved accessible directory: ${value}`);
  }

  touch(directory: string, rank?: number): void {
    const value = rank ?? ++this.sequence;
    this.recent.set(directory, value);
    this.sequence = Math.max(this.sequence, value);
  }

  isEligible(directory: string): boolean {
    try {
      this.validate(directory);
      return true;
    } catch {
      return false;
    }
  }

  private validate(requested: string): string {
    const canonical = accessibleDirectory(requested, "Working directory");
    if (!this.approved(canonical)) {
      throw new WorkspaceConfigError(`Working directory is outside WORKSPACE_ROOTS: ${requested}`);
    }
    return canonical;
  }

  private approved(canonical: string): boolean {
    return this.roots.some((root) => within(root, canonical));
  }

  private modifiedAt(candidate: string): number {
    try {
      return fs.statSync(candidate).mtimeMs;
    } catch {
      return 0;
    }
  }
}
