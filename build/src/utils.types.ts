import type { BaseContext, Commit, NextRelease } from "semantic-release";

export interface CommitWithFilePaths extends Commit {
  /**
   * List of file paths that were changed in this commit.
   *
   */
  filePaths: string[];
}

export interface ContextWithCommits extends BaseContext {
  /**
   * An array of commits representing a series of changes made to a software project.
   *
   */
  commits: readonly Commit[];
}

export interface ContextWithVersion extends BaseContext {
  /**
   * Represents the next release of the software.
   *
   */
  nextRelease: NextRelease;
}

export interface WorkspaceJSON {
  /**
   * The dependencies of the package.
   *
   */
  dependencies?: Record<string, string>;
  /**
   * Additional tooling dependencies that are not required for the package to work.
   * Usually test, build, or documentation tooling.
   *
   */
  devDependencies?: Record<string, string>;
  /**
   * The relative or absolute location of the workspace within the project.
   * Usually refers to where the package's source code is located.
   *
   */
  location: string;
  /**
   * The name of the package.
   *
   */
  name: string;
  /**
   * The file system path to the package, usually an absolute path.
   * This indicates the directory where the package.json and the associated files are located.
   *
   */
  path: string;
  /**
   * Dependencies that will usually be required by the package user
   * directly or via another dependency.
   *
   */
  peerDependencies?: Record<string, string>;
}
