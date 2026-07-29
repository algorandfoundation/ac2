#!/usr/bin/env node
/**
 * `ac2-ssh-sign` — the `gpg.ssh.program` shim for AC2 git signing.
 *
 * git invokes it like `ssh-keygen`:
 *
 *     ac2-ssh-sign -Y sign -n git [-U] -f <keyfile> <payload-file>
 *
 * Instead of using a local private key, the shim forwards the payload to the
 * git-signing bridge (Unix socket served by the process holding the active
 * AC2 session), waits for the wallet's approval, and writes the armored
 * result to `<payload-file>.sig` — exactly what git expects.
 *
 * Self-contained on purpose: node built-ins plus the sibling SSHSIG codec
 * only, so it starts fast and works without the host SDK being loadable.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

import { parseAuthorizedKeyLine } from './sshsig.js';

const DEFAULT_TIMEOUT_MS = 180_000;

interface ShimArgs {
    namespace: string;
    keyfile?: string;
    payloadFile?: string;
}

/** Parse the ssh-keygen-style argv git passes. Flags we don't need are skipped. */
export function parseShimArgs(argv: string[]): ShimArgs {
    const args: ShimArgs = { namespace: 'git' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '-n') {
            args.namespace = argv[++i] ?? 'git';
        } else if (arg === '-f') {
            const keyfile = argv[++i];
            if (keyfile !== undefined) args.keyfile = keyfile;
        } else if (arg === '-Y') {
            i++; // subcommand (always `sign`)
        } else if (arg === '-O') {
            i++; // option key=value
        } else if (arg.startsWith('-')) {
            // boolean flags such as -U (use agent for a literal key): ignore
        } else {
            args.payloadFile = arg;
        }
    }
    return args;
}

interface BridgeResponse {
    status?: string;
    armored?: string;
    reason?: string;
    error?: string;
}

function requestSignature(
    socketPath: string,
    request: Record<string, unknown>,
    timeoutMs: number,
): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let buffered = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error(`timed out after ${timeoutMs}ms waiting for wallet approval`));
        }, timeoutMs);
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        socket.setEncoding('utf8');
        socket.on('error', (err) =>
            finish(() =>
                reject(
                    new Error(
                        `cannot reach the AC2 git-signing bridge at ${socketPath} (${err.message}). ` +
                        'Is an `ac2` channel session active? Pair with `openclaw ac2 pair` first.',
                    ),
                ),
            ),
        );
        socket.on('data', (chunk: string) => {
            buffered += chunk;
            const newline = buffered.indexOf('\n');
            if (newline === -1) return;
            const line = buffered.slice(0, newline);
            socket.end();
            finish(() => {
                try {
                    resolve(JSON.parse(line) as BridgeResponse);
                } catch {
                    reject(new Error('malformed response from the AC2 git-signing bridge'));
                }
            });
        });
        socket.on('end', () => finish(() => reject(new Error('bridge closed without a response'))));
        socket.on('connect', () => {
            socket.write(`${JSON.stringify(request)}\n`);
        });
    });
}

/** Run the shim. Returns the process exit code. */
export async function runShim(
    argv: string[],
    env: NodeJS.ProcessEnv = process.env,
    stderr: (msg: string) => void = (msg) => process.stderr.write(`${msg}\n`),
): Promise<number> {
    const args = parseShimArgs(argv);
    if (!args.payloadFile) {
        stderr('ac2-ssh-sign: no payload file supplied (expected ssh-keygen -Y sign usage)');
        return 1;
    }

    let payload: Buffer;
    try {
        payload = readFileSync(args.payloadFile);
    } catch (err) {
        stderr(`ac2-ssh-sign: cannot read payload file: ${(err as Error).message}`);
        return 1;
    }

    let expectedKeyLine: string | undefined;
    if (args.keyfile) {
        try {
            const content = readFileSync(args.keyfile, 'utf8').trim();
            if (parseAuthorizedKeyLine(content)) expectedKeyLine = content;
        } catch {
            // Key file unreadable — proceed without a pinned key; the wallet's
            // response key is still verified against the signature itself.
        }
    }

    // The wrapper written by `openclaw ac2 git-config` always exports the
    // socket path (resolved at config time, when the OPENCLAW_* env is
    // known); re-deriving it here from the committing shell's environment
    // is what we must NOT do — it can differ from the bridge's.
    const socketPath = env['AC2_GIT_SIGN_SOCKET']?.trim();
    if (!socketPath) {
        stderr(
            'ac2-ssh-sign: AC2_GIT_SIGN_SOCKET is not set — run this via the wrapper ' +
            'written by `openclaw ac2 git-config` (re-run it to regenerate).',
        );
        return 1;
    }

    const timeoutMs = Number(env['AC2_GIT_SIGN_TIMEOUT_MS'] ?? '') || DEFAULT_TIMEOUT_MS;
    let response: BridgeResponse;
    try {
        response = await requestSignature(
            socketPath,
            {
                v: 1,
                payload_base64: payload.toString('base64'),
                namespace: args.namespace,
                ...(expectedKeyLine !== undefined ? { expected_public_key: expectedKeyLine } : {}),
            },
            timeoutMs,
        );
    } catch (err) {
        stderr(`ac2-ssh-sign: ${(err as Error).message}`);
        return 1;
    }

    if (response.status !== 'signed' || typeof response.armored !== 'string') {
        const detail = response.reason ?? response.error ?? 'unknown_error';
        if (detail === 'no_active_session') {
            stderr(
                'ac2-ssh-sign: no active AC2 wallet session — reconnect the wallet ' +
                '(`openclaw ac2 pair`) and retry the commit.',
            );
            return 1;
        }
        stderr(`ac2-ssh-sign: signing failed: ${detail}`);
        return 1;
    }

    try {
        writeFileSync(`${args.payloadFile}.sig`, response.armored);
    } catch (err) {
        stderr(`ac2-ssh-sign: cannot write signature file: ${(err as Error).message}`);
        return 1;
    }
    return 0;
}

const isMain = ((): boolean => {
    try {
        const entry = process.argv[1];
        if (!entry) return false;
        return pathToFileURL(realpathSync(entry)).href === import.meta.url;
    } catch {
        return false;
    }
})();

if (isMain) {
    runShim(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err) => {
            process.stderr.write(`ac2-ssh-sign: ${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        },
    );
}
