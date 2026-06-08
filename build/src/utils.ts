import { execSync } from "node:child_process";
import { EOL } from "node:os";
import path, { dirname, extname, normalize, relative, sep } from "node:path";
import { cwd } from "node:process";
import fs, { readFileSync } from "node:fs";

import memize from "memize";
import type { SemanticConfigType } from "semantic-release/lib/get-config.js";

import type { CommitWithFilePaths, ContextWithCommits, ContextWithVersion } from "./utils.types.js";

const memoizedIsPathWithin = memize((path: string, childPath: string): boolean => {
  const normalizedPath = normalize(path);
  const normalizedChildPath = normalize(childPath);

  const childSegmentPath =
    extname(normalizedChildPath) !== ""
      ? dirname(normalizedChildPath).split(sep)
      : normalizedChildPath.split(sep);

  return normalizedPath.split(sep).every((pathSegment, index) => {
    return pathSegment === childSegmentPath[index];
  });
});

const memoizedGit = memize((args: string): string => {
  return execSync(`git ${args}`).toString().trim();
});

export function modifyContextReleaseVersion<TContextType extends ContextWithVersion>(
  context: TContextType,
): TContextType {
  return {
    ...context,
    nextRelease: {
      ...context.nextRelease,
      // @ts-expect-error
      version: context.options.tagFormat.replace("${version}", context.nextRelease.version),
    },
  };
}

interface PnpmWorkspace {
  name: string;
  version: string;
  path: string;
  private: boolean;
}

export const memoizedGetWorkspaceManifest = memize(() => {
  try {
    const workspaces: PnpmWorkspace[] = JSON.parse(
      execSync("pnpm list -r --depth -1 --json").toString(),
    );
    const workingDirectory = cwd();
    const rootDir = execSync("git rev-parse --show-toplevel").toString().trim();

    const currentWorkspace = workspaces.find((workspace) => {
      return workspace.path === workingDirectory;
    });

    if (!currentWorkspace) {
      return null;
    }

    const pkgJson = JSON.parse(readFileSync(`${workingDirectory}/package.json`, "utf-8"));
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies,
    };

    const currentWorkspaceDependencies = workspaces.filter((workspace) => {
      return workspace.name in allDeps;
    });

    return {
      location: relative(rootDir, currentWorkspace.path),
      dependantWorkspaces: currentWorkspaceDependencies.map((currentWorkspaceDependency) => {
        return { location: relative(rootDir, currentWorkspaceDependency.path) };
      }),
    };
  } catch {
    return null;
  }
});

export function modifyContextCommits<TContextType extends ContextWithCommits>(
  context: TContextType,
  semanticConfig: SemanticConfigType,
): TContextType {
  if (!context.commits) {
    return context;
  }

  const currentWorkspace = memoizedGetWorkspaceManifest();

  const commitsWithFilePaths = context.commits.map((commit) => {
    return {
      ...commit,
      filePaths: memoizedGit(`diff-tree --root --no-commit-id --name-only -r ${commit.hash}`).split(
        EOL,
      ),
    };
  });

  const affectedCommits: CommitWithFilePaths[] = [];

  if (currentWorkspace) {
    affectedCommits.push(
      ...commitsWithFilePaths.filter((commitWithFilePaths) => {
        return commitWithFilePaths.filePaths.some((commitFilePath) => {
          return (
            memoizedIsPathWithin(currentWorkspace.location, commitFilePath) ||
            currentWorkspace.dependantWorkspaces.some((dependantWorkspace) =>
              memoizedIsPathWithin(dependantWorkspace.location, commitFilePath),
            )
          );
        });
      }),
    );
  }

  if (semanticConfig.options.processCommits) {
    affectedCommits.push(
      ...semanticConfig.options.processCommits(
        commitsWithFilePaths.filter((commitWithFilePaths) => {
          return !affectedCommits.some((affectedCommit) => {
            return commitWithFilePaths.hash === affectedCommit.hash;
          });
        }),
      ),
    );
  }

  return {
    ...context,
    commits: affectedCommits,
  };
}

export function synchronizeWorkspaceDependencies(workingDirectory: string): void {
  const workspaces: (PnpmWorkspace & {
    dependencies?: any;
    devDependencies?: any;
    peerDependencies?: any;
    optionalDependencies?: any;
  })[] = JSON.parse(execSync("pnpm list -r --json").toString());
  const pkgPath = path.join(workingDirectory, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

  const currentWorkspaceInfo = workspaces.find(
    (w) => path.normalize(w.path) === path.normalize(workingDirectory),
  );

  let changed = false;
  const dependencyTypes = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  for (const depType of dependencyTypes) {
    if (pkg[depType]) {
      for (const [name, version] of Object.entries(pkg[depType])) {
        const workspacePkg = workspaces.find((w) => w.name === name);
        if (workspacePkg) {
          if (workspacePkg.private) {
            // Exclude private packages, they must remain workspace: reference
            if (version !== "workspace:*") {
              pkg[depType][name] = "workspace:*";
              changed = true;
            }
            continue;
          }

          if (version === "workspace:*") {
            pkg[depType][name] = workspacePkg.version;
            changed = true;
          } else if (typeof version === "string" && version.startsWith("workspace:")) {
            // Handle other workspace: prefix formats if needed, e.g., workspace:^
            const resolvedVersion =
              version.replace("workspace:", "") === "*" ||
              version.replace("workspace:", "") === "^" ||
              version.replace("workspace:", "") === "~"
                ? workspacePkg.version
                : version.replace("workspace:", "");

            if (pkg[depType][name] !== resolvedVersion) {
              pkg[depType][name] = resolvedVersion;
              changed = true;
            }
          }
        } else if (
          typeof version === "string" &&
          version.startsWith("catalog:") &&
          currentWorkspaceInfo
        ) {
          const resolvedDep =
            currentWorkspaceInfo[depType]?.[name] ||
            currentWorkspaceInfo.dependencies?.[name] ||
            currentWorkspaceInfo.devDependencies?.[name] ||
            currentWorkspaceInfo.optionalDependencies?.[name] ||
            workspaces
              .map(
                (w) =>
                  w.dependencies?.[name] ||
                  w.devDependencies?.[name] ||
                  w.optionalDependencies?.[name] ||
                  w.peerDependencies?.[name],
              )
              .find((dep) => dep && dep.version);

          if (resolvedDep && resolvedDep.version) {
            pkg[depType][name] = resolvedDep.version;
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    updateLockfile();
  }
}

export function updateLockfile(): void {
  try {
    const rootDir = execSync("git rev-parse --show-toplevel").toString().trim();
    console.log(`[@algorandfoundation/package-releaser]: Updating lockfile in ${rootDir}`);
    execSync("pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile", {
      cwd: rootDir,
    });
  } catch (e) {
    console.error("Failed to update lockfile:", e);
  }
}
