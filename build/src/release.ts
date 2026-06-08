import fs from "node:fs";
import path from "node:path";
import type {
  AnalyzeCommitsContext,
  Config,
  GenerateNotesContext,
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from "semantic-release";
import type { SemanticConfigType } from "semantic-release/lib/get-config.js";

import {
  modifyContextCommits,
  modifyContextReleaseVersion,
  synchronizeWorkspaceDependencies,
  updateLockfile,
} from "./utils.js";

export function createInlinePlugin(semanticConfig: SemanticConfigType) {
  // biome-ignore lint/suspicious/useAwait: semantic-release expect steps to return Promise
  const verifyConditions = async (_: Config, context: VerifyConditionsContext) => {
    context.logger.log(
      `[@algorandfoundation/package-releaser]: Starting verifyConditions for ${context.cwd}`,
    );
    return semanticConfig.plugins.verifyConditions(
      modifyContextCommits(context as any, semanticConfig),
    );
  };

  // biome-ignore lint/suspicious/useAwait: semantic-release expect steps to return Promise
  const analyzeCommits = async (_: Config, context: AnalyzeCommitsContext) => {
    return semanticConfig.plugins.analyzeCommits(modifyContextCommits(context, semanticConfig));
  };

  // biome-ignore lint/suspicious/useAwait: semantic-release expect steps to return Promise
  const generateNotes = async (_: Config, context: GenerateNotesContext) => {
    return semanticConfig.plugins.generateNotes(
      modifyContextCommits(modifyContextReleaseVersion(context), semanticConfig),
    );
  };

  // biome-ignore lint/suspicious/useAwait: semantic-release expect steps to return Promise
  const prepare = async (_: Config, context: PrepareContext) => {
    context.logger.log(
      `[@algorandfoundation/package-releaser]: Starting prepare for ${context.cwd}`,
    );
    const result = await semanticConfig.plugins.prepare(
      modifyContextCommits(context, semanticConfig),
    );
    updateLockfile();
    return result;
  };

  const publish = async (_: Config, context: PublishContext) => {
    const workingDirectory = context.cwd ?? process.cwd();
    context.logger.log(
      `[@algorandfoundation/package-releaser]: Starting publish for ${workingDirectory}`,
    );
    const pkgPath = path.join(workingDirectory, "package.json");
    const originalPkgContent = fs.readFileSync(pkgPath, "utf-8");

    try {
      synchronizeWorkspaceDependencies(workingDirectory);
      const [response] = await semanticConfig.plugins.publish(
        modifyContextCommits(context, semanticConfig),
      );
      return response ?? {};
    } finally {
      const newPkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const restoredPkg = JSON.parse(originalPkgContent);
      restoredPkg.version = newPkg.version;
      fs.writeFileSync(pkgPath, `${JSON.stringify(restoredPkg, null, 2)}\n`);
      updateLockfile();
    }
  };

  const inlinePlugin = {
    verifyConditions,
    analyzeCommits,
    generateNotes,
    prepare,
    publish,
  };

  for (const value of Object.values(inlinePlugin)) {
    Reflect.defineProperty(value, "pluginName", {
      enumerable: true,
      value: "@algorandfoundation/package-releaser-inline-plugin",
      writable: false,
    });
  }

  return inlinePlugin;
}
