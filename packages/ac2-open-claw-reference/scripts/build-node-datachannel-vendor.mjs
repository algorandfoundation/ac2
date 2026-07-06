#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const require = createRequire(import.meta.url);
const ifMissing = process.argv.includes('--if-missing');

function findPackageRoot(entrypoint) {
  let dir = dirname(realpathSync(entrypoint));
  const root = parse(dir).root;
  while (dir !== root) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not locate package root for ${entrypoint}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? pkgRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function check(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function macDependencies(binary) {
  const output = commandOutput('otool', ['-L', binary]);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(
      (dep) =>
        dep &&
        dep !== binary &&
        !dep.startsWith('/usr/lib/') &&
        !dep.startsWith('/System/Library/') &&
        !dep.startsWith('@'),
    );
}

function vendorMacDylibs(vendorDir, rootBinary) {
  const copied = new Map();
  const queue = macDependencies(rootBinary);

  while (queue.length > 0) {
    const dep = queue.shift();
    if (!dep || copied.has(dep)) continue;

    const basename = dep.split('/').pop();
    const target = resolve(vendorDir, basename);
    if (!existsSync(target)) {
      copyFileSync(dep, target);
    }
    copied.set(dep, basename);

    for (const child of macDependencies(dep)) {
      if (!copied.has(child)) queue.push(child);
    }
  }

  const patchable = [
    resolve(vendorDir, 'node_datachannel.node'),
    ...readdirSync(vendorDir)
      .filter((name) => name.endsWith('.dylib'))
      .map((name) => resolve(vendorDir, name)),
  ].filter((file) => statSync(file).isFile());

  for (const file of patchable) {
    if (file.endsWith('.dylib')) {
      run('install_name_tool', ['-id', `@loader_path/${file.split('/').pop()}`, file]);
    }
    for (const [original, basename] of copied) {
      run('install_name_tool', ['-change', original, `@loader_path/${basename}`, file]);
    }
    run('codesign', ['--force', '--sign', '-', file]);
  }
}

function linuxDependencies(binary) {
  const output = commandOutput('ldd', [binary]);
  return output
    .split(/\r?\n/)
    .map((line) => {
      const resolved = line.match(/=>\s+(\/\S+)\s+\(/)?.[1];
      if (resolved) return resolved;
      return line.trim().match(/^(\/\S+)\s+\(/)?.[1];
    })
    .filter(Boolean)
    .filter((dep) => !dep.includes('linux-vdso') && !dep.includes('ld-linux'));
}

function shouldBundleLinuxLibrary(dep) {
  const name = dep.split('/').pop();
  return ![
    /^libc\.so/,
    /^libm\.so/,
    /^libpthread\.so/,
    /^libdl\.so/,
    /^librt\.so/,
    /^libgcc_s\.so/,
    /^libstdc\+\+\.so/,
  ].some((pattern) => pattern.test(name));
}

function vendorLinuxSharedLibraries(vendorDir, rootBinary) {
  if (!check('patchelf', ['--version'])) {
    console.error('[ac2] patchelf is required to vendor Linux node-datachannel libraries.');
    process.exit(1);
  }

  const copied = new Set();
  const queue = linuxDependencies(rootBinary).filter(shouldBundleLinuxLibrary);

  while (queue.length > 0) {
    const dep = queue.shift();
    if (!dep) continue;
    const basename = dep.split('/').pop();
    if (copied.has(basename)) continue;
    copyFileSync(dep, resolve(vendorDir, basename));
    copied.add(basename);

    for (const child of linuxDependencies(dep)) {
      if (shouldBundleLinuxLibrary(child)) queue.push(child);
    }
  }

  for (const file of [
    resolve(vendorDir, 'node_datachannel.node'),
    ...readdirSync(vendorDir)
      .filter((name) => name.endsWith('.so') || name.includes('.so.'))
      .map((name) => resolve(vendorDir, name)),
  ]) {
    if (statSync(file).isFile()) {
      run('patchelf', ['--set-rpath', '$ORIGIN', file]);
    }
  }
}

const nodeDataChannelRoot = findPackageRoot(require.resolve('node-datachannel'));
const nodeDataChannelPackage = JSON.parse(
  readFileSync(resolve(nodeDataChannelRoot, 'package.json'), 'utf8'),
);
const platformKey = `${process.platform}-${process.arch}`;
const vendorDir = resolve(pkgRoot, 'vendor', 'node-datachannel', platformKey);
const vendorBinary = resolve(vendorDir, 'node_datachannel.node');

if (ifMissing && existsSync(vendorBinary)) {
  console.log(`[ac2] using existing libnice node-datachannel artifact for ${platformKey}`);
  process.exit(0);
}

if (!check('cmake', ['--version'])) {
  console.error(
    '[ac2] cmake is required to build the libnice node-datachannel vendor artifact.',
  );
  process.exit(1);
}
if (!check('pkg-config', ['--exists', 'nice'])) {
  console.error(
    '[ac2] libnice development files are required to build the AC2 node-datachannel artifact.',
  );
  console.error('[ac2] macOS: brew install libnice');
  console.error('[ac2] Debian/Ubuntu: sudo apt-get install libnice-dev');
  process.exit(1);
}

run('npm', ['install', '--ignore-scripts', '--production=false'], {
  cwd: nodeDataChannelRoot,
  env: { npm_config_fund: 'false', npm_config_audit: 'false' },
});
run('npx', ['cmake-js', 'clean'], { cwd: nodeDataChannelRoot });
run('npx', ['cmake-js', 'configure', '--CDUSE_NICE=1'], { cwd: nodeDataChannelRoot });
run('npx', ['cmake-js', 'build'], { cwd: nodeDataChannelRoot });

const sourceBinary = resolve(nodeDataChannelRoot, 'build', 'Release', 'node_datachannel.node');
rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
copyFileSync(sourceBinary, resolve(vendorDir, 'node_datachannel.node'));
if (process.platform === 'darwin') {
  vendorMacDylibs(vendorDir, resolve(vendorDir, 'node_datachannel.node'));
} else if (process.platform === 'linux') {
  vendorLinuxSharedLibraries(vendorDir, resolve(vendorDir, 'node_datachannel.node'));
}
writeFileSync(
  resolve(vendorDir, 'manifest.json'),
  `${JSON.stringify(
    {
      nodeDataChannel: nodeDataChannelPackage.version,
      platform: process.platform,
      arch: process.arch,
      backend: 'libnice',
      binary: 'node_datachannel.node',
    },
    null,
    2,
  )}\n`,
);

console.log(`[ac2] staged libnice node-datachannel artifact for ${platformKey}`);
