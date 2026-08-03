/**
 * Prepare the Docker plugin-builder stage's package.json copies for packing.
 *
 * `pack-selfcontained.mjs` runs `pnpm pack` on ac2-sdk and ac2-cli, and pnpm
 * can only rewrite `workspace:*` specifiers when the referenced workspace
 * packages are actually installed (symlinked into node_modules) — which they
 * never are in the builder stage, where only sources are copied. Instead of
 * paying for a full `pnpm install`, rewrite the (throwaway) builder copies:
 *
 *   - drop `devDependencies` entirely (that is where refs to unpublished
 *     workspace tooling like @algorandfoundation/package-releaser live, and a
 *     packed tarball has no use for them),
 *   - pin any remaining `workspace:` specifier in dependencies /
 *     optionalDependencies / peerDependencies to the concrete version of the
 *     referenced workspace package (exactly what `pnpm pack` would produce).
 *
 * Usage: node prepare-builder-manifests.mjs <workspace-root>
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const packagesDir = join(root, 'packages');

/** name → version for every workspace package present in the builder copy. */
const workspaceVersions = new Map();
for (const dir of [...readdirSync(packagesDir).map((d) => join(packagesDir, d)), join(root, 'build')]) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (pkg.name && pkg.version) workspaceVersions.set(pkg.name, pkg.version);
}

for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));

  delete pkg.devDependencies;

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
      const version = workspaceVersions.get(name);
      if (!version) {
        throw new Error(`${pkg.name}: ${field}.${name} is "${spec}" but ${name} is not in the builder copy`);
      }
      deps[name] = version;
    }
  }

  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[builder-manifests] prepared ${pkg.name}`);
}
