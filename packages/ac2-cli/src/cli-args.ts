/** Hand-rolled argument parsing for the `ac2` CLI (no parsing dependency). */

/** Flags recognized across every `ac2` subcommand. */
export interface CliFlags {
  foreground?: boolean;
  origin?: string;
  agent?: string;
  autoPair?: boolean;
  lines?: number;
  timeout?: number;
  all?: boolean;
  id?: string;
  help?: boolean;
}

/** The parsed command path (e.g. `['service', 'start']`) plus its flags. */
export interface ParsedCliArgs {
  command: string[];
  flags: CliFlags;
}

type FlagType = 'boolean' | 'string' | 'number';

const FLAG_SPECS: Record<string, { key: keyof CliFlags; type: FlagType }> = {
  '--foreground': { key: 'foreground', type: 'boolean' },
  '--origin': { key: 'origin', type: 'string' },
  '--agent': { key: 'agent', type: 'string' },
  '--auto-pair': { key: 'autoPair', type: 'boolean' },
  '-n': { key: 'lines', type: 'number' },
  '--lines': { key: 'lines', type: 'number' },
  '--timeout': { key: 'timeout', type: 'number' },
  '--all': { key: 'all', type: 'boolean' },
  '--id': { key: 'id', type: 'string' },
  '--help': { key: 'help', type: 'boolean' },
  '-h': { key: 'help', type: 'boolean' },
};

/** Raised on an unknown flag or a flag missing its required value. */
export class CliArgsError extends Error {}

/**
 * Parse `argv` (already stripped of `node` / script path) into a command
 * path and a flat set of flags. Unknown leading tokens (not starting with
 * `-`) accumulate into `command`; recognized flags are extracted regardless
 * of position.
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const command: string[] = [];
  const flags: CliFlags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    const spec = FLAG_SPECS[arg];
    if (spec) {
      if (spec.type === 'boolean') {
        (flags as Record<string, unknown>)[spec.key] = true;
        i += 1;
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined) {
        throw new CliArgsError(`missing value for ${arg}`);
      }
      (flags as Record<string, unknown>)[spec.key] = spec.type === 'number' ? Number(value) : value;
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliArgsError(`unknown flag: ${arg}`);
    }
    command.push(arg);
    i += 1;
  }
  return { command, flags };
}
