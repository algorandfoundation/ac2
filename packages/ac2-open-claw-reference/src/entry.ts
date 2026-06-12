/**
 * OpenClaw host entry for the `ac2` channel
 * (`openclaw.extensions: ["./dist/entry.js"]`). Built on
 * `defineBundledChannelEntry` from `openclaw/plugin-sdk/channel-entry-contract`.
 */

import { defineBundledChannelEntry } from 'openclaw/plugin-sdk/channel-entry-contract';

import pluginManifest from './tools/manifest.js';
import { PLUGIN_ID, setActiveApi, setActiveRuntime, type OpenClawApi } from './runtime.js';
import { getToolPluginMetadata } from './session/contracts.js';
import { sessionManager } from './session/manager.js';
import { buildSignTool, buildCapabilitiesTool } from './tools/index.js';
import { cmdSetup } from './setup/config.js';
import { listConnections } from './identity/state.js';

const MANIFEST_DESCRIPTION =
  getToolPluginMetadata(pluginManifest)?.description ??
  'Reference OpenClaw plugin for the AC2 protocol.';

function setActive(api: OpenClawApi): void {
  setActiveApi(api);
  if (api.runtime) setActiveRuntime(api.runtime);
}

let cliMetadataRegistered = false;

/** Dynamically import the `ac2` CLI command (keeps the transport out of cold start). */
async function runAc2CommandHandler(
  api: OpenClawApi,
  ctx: { args?: string; isCli?: boolean },
): Promise<{ text: string }> {
  const { buildAc2Command } = await import('./cli/index.js');
  const command = buildAc2Command(api) as {
    handler: (c: { args?: string; isCli?: boolean }) => Promise<{ text: string }>;
  };
  return command.handler(ctx);
}

/** `/ac2` slash command — read-only status / help. Pairing lives on the shell CLI. */
function runAc2SlashCommand(ctx: { args?: string }): { text: string } {
  const sub = (ctx.args ?? '').trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase();

  if (sub === 'status') {
    const active = sessionManager.getActive();
    const lines = ['AC2 channel status', '', `Online: ${active ? 'yes' : 'no'}`];
    if (active) {
      lines.push(`Agent DID:      ${active.agentDid}`);
      lines.push(`Controller DID: ${active.controllerDid}`);
      if (active.requestId) lines.push(`Connection:     ${active.requestId}`);
    }
    let known = 0;
    try {
      known = listConnections().length;
    } catch {
      // persisted-state read is best-effort
    }
    lines.push(`Known connections: ${known}`);
    return { text: lines.join('\n') };
  }

  // Default / `help`: a concise help blurb. Pairing and the read-only
  // diagnostics live on the shell CLI, which can hold the connection open.
  return {
    text: [
      'AC2 — agent ↔ wallet channel over Liquid Auth + WebRTC.',
      '',
      'Usage:',
      '  /ac2            Show this help.',
      '  /ac2 status     Show the live channel/session status.',
      '',
      'Pairing & diagnostics run from the shell (they hold the connection open):',
      '  openclaw ac2 pair         Start pairing and render the QR code.',
      '  openclaw ac2 connections  List known connections + agent identities.',
      '  openclaw ac2 forget       Clear the saved pairing record.',
      '  openclaw ac2 setup        Print/update channel configuration.',
    ].join('\n'),
  };
}

/** SDK `registerCliMetadata` — surface `/ac2` and `openclaw ac2` without booting the channel. */
function registerCliMetadata(api: OpenClawApi): void {
  setActive(api);
  if (cliMetadataRegistered) return;
  cliMetadataRegistered = true;

  const ac2SlashCommand = {
    name: 'ac2',
    description: 'AC2 channel status & help (pairing runs via `openclaw ac2`).',
    acceptsArgs: true,
    requireAuth: false,
    handler(ctx: { args?: string }): { text: string } {
      return runAc2SlashCommand(ctx);
    },
  };
  try {
    if (typeof api.registerCommand === 'function') {
      api.registerCommand(ac2SlashCommand as Parameters<typeof api.registerCommand>[0]);
    }
  } catch (err) {
    console.error(`[${PLUGIN_ID}] registerCommand failed: ${err}`);
  }

  // Shell CLI: `openclaw ac2 <subcommand> [args...]`.
  try {
    if (typeof api.registerCli === 'function') {
      api.registerCli(
        ({ program }) => {
          program
            .command('ac2 [args...]')
            .description('AC2 channel control (pair, status, forget, setup).')
            .action(async (...args: unknown[]) => {
              const rawArgs = Array.isArray(args[0]) ? (args[0] as string[]) : [];
              const sub = rawArgs[0];

              if (sub === 'setup') {
                console.log(cmdSetup());
                process.exit(0);
              }

              const result = await runAc2CommandHandler(api, {
                args: rawArgs.join(' '),
                isCli: true,
              });
              console.log(result.text);

              const isPair = !sub || sub === 'pair';
              if (isPair) {
                console.log('\n[ac2] Waiting for controller to pair... (Ctrl+C to stop)');
                const keepAlive = setInterval(() => {}, 60000);

                let stopping = false;
                let stdinHandler: ((chunk: Buffer | string) => void) | undefined;
                const stop = (signal: string): void => {
                  if (stopping) {
                    process.exit(130);
                  }
                  stopping = true;
                  console.log(`\n[ac2] ${signal} received — stopping pairing...`);
                  clearInterval(keepAlive);
                  try {
                    if (stdinHandler) process.stdin.off('data', stdinHandler);
                    if (typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY) {
                      process.stdin.setRawMode(false);
                    }
                    process.stdin.pause();
                  } catch {
                    // best-effort terminal restore
                  }
                  try {
                    sessionManager.getActive()?.transport.close();
                  } catch {
                    // best-effort teardown
                  }
                  sessionManager.clearActive();
                  setTimeout(() => process.exit(0), 150).unref();
                };
                process.on('SIGINT', () => stop('SIGINT'));
                process.on('SIGTERM', () => stop('SIGTERM'));

                try {
                  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
                    process.stdin.setRawMode(true);
                  }
                  process.stdin.resume();
                  stdinHandler = (chunk: Buffer | string): void => {
                    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                    if (str.includes('\u0003') || str.includes('\u0004')) {
                      stop('Ctrl+C');
                    }
                  };
                  process.stdin.on('data', stdinHandler);
                } catch {
                  // If stdin isn't available, the signal handlers remain the stop path.
                }
              } else {
                process.exit(0);
              }
            });
        },
        { commands: ['ac2'] },
      );
    }
  } catch (err) {
    console.error(`[${PLUGIN_ID}] registerCli failed: ${err}`);
  }
}

/** SDK `registerFull` — register the `ac2_sign` and `ac2_capabilities` tools. */
function registerFull(api: OpenClawApi): void {
  setActive(api);
  try {
    if (typeof api.registerTool === 'function') {
      api.registerTool(buildSignTool());
      api.registerTool(buildCapabilitiesTool());
    }
  } catch (err) {
    console.error(`[${PLUGIN_ID}] registerTool failed: ${err}`);
  }
}

/** The bundled channel entry. */
export const pluginEntry = defineBundledChannelEntry({
  id: PLUGIN_ID,
  name: 'AC2 Reference',
  description: MANIFEST_DESCRIPTION,
  importMetaUrl: import.meta.url,
  plugin: { specifier: './channel.plugin.js', exportName: 'channelPlugin' },
  registerCliMetadata,
  registerFull,
});

export default pluginEntry;

export const register = pluginEntry.register;
export const activate = register;
export const id = PLUGIN_ID;
