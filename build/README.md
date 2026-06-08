# @algorandfoundation/package-releaser

`@algorandfoundation/package-releaser` is a custom release tool built on top of `semantic-release`. It is designed for use in a monorepo setup, allowing individual packages (extensions) to be released independently while sharing a global release configuration.

## Features

- **Monorepo Compatibility**: Correctly handles releases for individual packages within a monorepo.
- **Root Configuration Inheritance**: Automatically searches for and uses the `release` configuration defined in the root `package.json`.
- **Package-Specific Tagging**: Automatically formats git tags as `package-name@version` (e.g., `keystore@1.0.1`). Note: the `@algorandfoundation/` scope is automatically removed from the tag name.
- **Scoped Release Commits**: Customizes the `@semantic-release/git` commit message to include the name of the package being released (without the `@algorandfoundation/` scope), followed by its release notes.
- **Filtered Commits**: Only includes commits that affect the current package's directory or its workspace dependencies.

## Usage in Extensions

To use this tool in an extension (package) within this monorepo, follow these steps:

### 1. Add the Dependency

Add `@algorandfoundation/package-releaser` to the `dependencies` or `devDependencies` of your package.

```json
{
  "dependencies": {
    "@algorandfoundation/package-releaser": "0.0.1"
  }
}
```

### 2. Add the Release Script

Add a `release` script to your package's `package.json`. This script should call `package-releaser`.

```json
{
  "scripts": {
    "release": "package-releaser"
  }
}
```

### 3. Run the Release

You can now run the release from within the package directory:

```bash
npm run release
```

Or from the root of the monorepo using workspaces:

```bash
npm run release -w @algorandfoundation/keystore
```

## Global Configuration

The tool expects a `release` configuration in the root `package.json` of the monorepo. It supports standard `semantic-release` plugins and options.

### Example Root `package.json` Configuration

```json
{
  "release": {
    "plugins": [
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      "@semantic-release/npm",
      [
        "@semantic-release/git",
        {
          "assets": ["CHANGELOG.md", "package.json"]
        }
      ],
      "@semantic-release/github"
    ],
    "branches": ["main", "release"]
  }
}
```

## CLI Options

The tool supports several `semantic-release` CLI flags:

- `--ci`: Set to `false` to skip Continuous Integration environment verifications.
- `--debug`: Output debugging information.
- `--dry-run`: Run in dry-run mode to see what would happen without actually releasing.

Example:

```bash
npm run release -- --dry-run
```

## Technical Implementation Details

The tool implements a `semantic-release` inline plugin that:

1. Filters commits based on the files they change, ensuring only relevant changes trigger a release for the specific package.
2. Intercepts the `@semantic-release/git` plugin configuration to inject a package-specific commit message: `chore(release): [skip ci] package-name \n\n${nextRelease.notes}`. (Where `package-name` is the package name without the `@algorandfoundation/` scope).
