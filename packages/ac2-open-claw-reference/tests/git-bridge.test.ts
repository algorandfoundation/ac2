import { describe, it, expect, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../src/session/manager.js';
import {
    ensureGitSignBridge,
    stopGitSignBridge,
    type GitSignBridgeResponse,
} from '../src/git/bridge.js';
import { runShim, parseShimArgs, shimSocketPath } from '../src/git/shim.js';
import {
    buildSshSigSignedData,
    decodeSshSigArmor,
    toAuthorizedKeyLine,
    verifyEd25519,
} from '../src/git/sshsig.js';

const COMMIT = Buffer.from(
    ['tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904', '', 'feat: bridge test', ''].join('\n'),
);

function walletFixture(): { manager: SessionManager; rawPublicKey: Buffer } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
    const client = {
        async requestSignature(args: any) {
            const payload = Buffer.from(args.body.payload, 'base64');
            return {
                kind: 'response',
                message: {
                    thid: 'thid-bridge',
                    body: {
                        signature: cryptoSign(null, payload, privateKey).toString('base64'),
                        public_key: rawPublicKey.toString('base64'),
                    },
                },
            };
        },
    };
    const manager = new SessionManager();
    manager.setActive({
        transport: {} as never,
        client: client as never,
        controllerDid: 'did:key:controller',
        agentDid: 'did:key:agent',
        identityGranted: true,
    });
    return { manager, rawPublicKey };
}

async function startBridge(
    manager: SessionManager,
    socketPath: string,
): Promise<ReturnType<typeof ensureGitSignBridge>> {
    const server = ensureGitSignBridge({}, { manager, socketPath });
    if (!server.listening) await once(server, 'listening');
    return server;
}

function requestOverSocket(socketPath: string, request: unknown): Promise<GitSignBridgeResponse> {
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let buffered = '';
        socket.setEncoding('utf8');
        socket.on('error', reject);
        socket.on('data', (chunk: string) => {
            buffered += chunk;
            const newline = buffered.indexOf('\n');
            if (newline === -1) return;
            socket.end();
            resolve(JSON.parse(buffered.slice(0, newline)));
        });
        socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    });
}

describe('git-sign bridge', () => {
    afterEach(async () => {
        await stopGitSignBridge();
    });

    it('signs a payload end-to-end over the unix socket', async () => {
        const { manager, rawPublicKey } = walletFixture();
        const socketPath = join(mkdtempSync(join(tmpdir(), 'ac2-bridge-')), 'sign.sock');
        await startBridge(manager, socketPath);

        const response = await requestOverSocket(socketPath, {
            v: 1,
            payload_base64: COMMIT.toString('base64'),
            namespace: 'git',
        });

        expect(response.status).toBe('signed');
        if (response.status !== 'signed') return;
        const decoded = decodeSshSigArmor(response.armored);
        expect(decoded.publicKey).toEqual(rawPublicKey);
        expect(verifyEd25519(buildSshSigSignedData(COMMIT), decoded.signature, decoded.publicKey)).toBe(
            true,
        );
    });

    it('rejects with no_active_session when no session is active', async () => {
        const manager = new SessionManager();
        const socketPath = join(mkdtempSync(join(tmpdir(), 'ac2-bridge-')), 'sign.sock');
        await startBridge(manager, socketPath);

        const response = await requestOverSocket(socketPath, {
            v: 1,
            payload_base64: COMMIT.toString('base64'),
        });
        expect(response).toMatchObject({ status: 'rejected', reason: 'no_active_session' });
    });

    it('answers malformed requests with an error instead of hanging', async () => {
        const { manager } = walletFixture();
        const socketPath = join(mkdtempSync(join(tmpdir(), 'ac2-bridge-')), 'sign.sock');
        await startBridge(manager, socketPath);

        const response = await requestOverSocket(socketPath, { nope: true });
        expect(response).toMatchObject({ status: 'error', error: 'malformed_request' });
    });

    it('is idempotent across repeated ensure calls', async () => {
        const { manager } = walletFixture();
        const socketPath = join(mkdtempSync(join(tmpdir(), 'ac2-bridge-')), 'sign.sock');
        const first = await startBridge(manager, socketPath);
        const second = ensureGitSignBridge({}, { manager, socketPath });
        expect(second).toBe(first);
    });
});

describe('ac2-ssh-sign shim', () => {
    afterEach(async () => {
        await stopGitSignBridge();
    });

    it('parses the ssh-keygen argv git produces (including -U literals)', () => {
        const args = parseShimArgs(['-Y', 'sign', '-n', 'git', '-U', '-f', '/tmp/key', '/tmp/buf']);
        expect(args).toEqual({ namespace: 'git', keyfile: '/tmp/key', payloadFile: '/tmp/buf' });
    });

    it('resolves the socket path from AC2_GIT_SIGN_SOCKET first', () => {
        expect(shimSocketPath({ AC2_GIT_SIGN_SOCKET: '/tmp/x.sock' } as NodeJS.ProcessEnv)).toBe(
            '/tmp/x.sock',
        );
        expect(shimSocketPath({ OPENCLAW_STATE_DIR: '/state' } as NodeJS.ProcessEnv)).toBe(
            '/state/ac2/git-sign.sock',
        );
    });

    it('writes <payload>.sig for git end-to-end through the bridge', async () => {
        const { manager, rawPublicKey } = walletFixture();
        const dir = mkdtempSync(join(tmpdir(), 'ac2-shim-'));
        const socketPath = join(dir, 'sign.sock');
        await startBridge(manager, socketPath);

        const payloadFile = join(dir, 'commit-buffer');
        writeFileSync(payloadFile, COMMIT);
        const keyfile = join(dir, 'signing-key.pub');
        writeFileSync(keyfile, `${toAuthorizedKeyLine(rawPublicKey)}\n`);

        const errors: string[] = [];
        const code = await runShim(
            ['-Y', 'sign', '-n', 'git', '-f', keyfile, payloadFile],
            { AC2_GIT_SIGN_SOCKET: socketPath } as NodeJS.ProcessEnv,
            (msg) => errors.push(msg),
        );

        expect(code, errors.join('\n')).toBe(0);
        const armored = readFileSync(`${payloadFile}.sig`, 'utf8');
        const decoded = decodeSshSigArmor(armored);
        expect(decoded.namespace).toBe('git');
        expect(decoded.publicKey).toEqual(rawPublicKey);
    });

    it('pins the keyfile key: a different wallet key fails the commit', async () => {
        const { manager } = walletFixture();
        const dir = mkdtempSync(join(tmpdir(), 'ac2-shim-'));
        const socketPath = join(dir, 'sign.sock');
        await startBridge(manager, socketPath);

        const payloadFile = join(dir, 'commit-buffer');
        writeFileSync(payloadFile, COMMIT);
        const keyfile = join(dir, 'signing-key.pub');
        writeFileSync(keyfile, `${toAuthorizedKeyLine(Buffer.alloc(32, 9))}\n`);

        const errors: string[] = [];
        const code = await runShim(
            ['-Y', 'sign', '-n', 'git', '-f', keyfile, payloadFile],
            { AC2_GIT_SIGN_SOCKET: socketPath } as NodeJS.ProcessEnv,
            (msg) => errors.push(msg),
        );

        expect(code).toBe(1);
        expect(errors.join('\n')).toContain('public_key_mismatch');
        expect(existsSync(`${payloadFile}.sig`)).toBe(false);
    });

    it('fails fast with a helpful message when the bridge is down', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ac2-shim-'));
        const payloadFile = join(dir, 'commit-buffer');
        writeFileSync(payloadFile, COMMIT);

        const errors: string[] = [];
        const code = await runShim(
            ['-Y', 'sign', '-n', 'git', payloadFile],
            { AC2_GIT_SIGN_SOCKET: join(dir, 'missing.sock') } as NodeJS.ProcessEnv,
            (msg) => errors.push(msg),
        );
        expect(code).toBe(1);
        expect(errors.join('\n')).toContain('openclaw ac2 pair');
    });
});
