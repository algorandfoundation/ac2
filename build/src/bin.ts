#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs";

import { cosmiconfig } from "cosmiconfig";
import meow from "meow";
import { readPackage } from "read-pkg";
import type { Options } from "semantic-release";
import semanticRelease from "semantic-release";
import semanticGetConfig from "semantic-release/lib/get-config.js";

import { createInlinePlugin } from "./release.js";
import { RescopedStream } from "./stream.js";

import pkg from "../../package.json" with { type: "json" };

const { Signale } = createRequire(import.meta.url)("signale");

const cli = meow(
  `
    Usage
        $ package-releaser

    Options
        --ci        Set to false to skip Continuous Integration environment verifications
        --debug     Output debugging information. 
        --dry-run   Dry run mode.

    Examples
        $ package-releaser --debug
`,
  {
    flags: {
      ci: {
        type: "boolean",
      },
      debug: {
        type: "boolean",
      },
      dryRun: {
        type: "boolean",
      },
    },
    importMeta: import.meta,
  },
);

try {
  const monoPackage = await readPackage().catch(() => null);
  const rawSemanticConfig = await cosmiconfig("release").search(
    new URL("../../", import.meta.url).pathname,
  );

  const packageName = monoPackage?.name?.split("/").pop();
  console.log(`[${pkg.name}]: Processing package ${monoPackage?.name}`);
  console.log(`[${pkg.name}]: Current working directory: ${process.cwd()}`);
  console.log(`[${pkg.name}]: NPM_CONFIG_PROVENANCE before: ${process.env.NPM_CONFIG_PROVENANCE}`);
  if (monoPackage?.publishConfig?.provenance === true && !process.env.NPM_CONFIG_PROVENANCE) {
    console.log(`[${pkg.name}]: Setting NPM_CONFIG_PROVENANCE=true for ${monoPackage.name}`);
    process.env.NPM_CONFIG_PROVENANCE = "true";
  }
  console.log(`[${pkg.name}]: NPM_CONFIG_PROVENANCE after: ${process.env.NPM_CONFIG_PROVENANCE}`);

  const options: Options = {
    tagFormat: packageName ? `${packageName}@\${version}` : undefined,
    ...rawSemanticConfig?.config,
    ...cli.flags,
  };
  console.log(`[${pkg.name}]: Dry run: ${options.dryRun}`);
  console.log(`[${pkg.name}]: Using options ${JSON.stringify(options, null, 2)}`);

  if (options.plugins) {
    options.plugins = options.plugins.map((plugin) => {
      if (Array.isArray(plugin) && plugin[0] === "@semantic-release/git") {
        return [
          plugin[0],
          {
            ...plugin[1],
            message: `chore(release): ${packageName} \n\n\${nextRelease.notes}`,
          },
        ];
      }

      return plugin;
    });
  }

  const monoContext = {
    cwd: process.cwd(),
    env: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
  };

  const semanticConfig = await semanticGetConfig(
    {
      ...monoContext,
      logger: new Signale({ stream: new RescopedStream(monoContext.stderr, pkg.name) }),
    },
    options,
  );

  const inlinePlugin = createInlinePlugin(semanticConfig);

  const result = await semanticRelease(
    { ...options, ...inlinePlugin },
    {
      cwd: monoContext.cwd,
      env: monoContext.env,
      stderr: new RescopedStream(monoContext.stderr, pkg.name) as any,
      stdout: new RescopedStream(monoContext.stdout, pkg.name) as any,
    },
  );

  if (result && !options.dryRun && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "released=true\n");
  }

  process.exit(0);
} catch (error) {
  console.error(`[${pkg.name}]:`, error);
  process.exit(1);
}
