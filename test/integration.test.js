'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateMasterKey } = require('../src/keys');
const { decodeToken } = require('../src/token');

function tempDir(prefix = 'tgbackup-it-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTree(root) {
    fs.mkdirSync(path.join(root, 'data', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'notes.txt'), 'hello from tgbackup\n'.repeat(1000));
    fs.writeFileSync(path.join(root, 'data', 'nested', 'random.bin'), crypto.randomBytes(700 * 1024));
    fs.writeFileSync(path.join(root, 'data', 'nested', 'more.bin'), crypto.randomBytes(350 * 1024));
}

function readTree(root) {
    const files = {};
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else files[path.relative(root, full)] = fs.readFileSync(full);
        }
    };
    walk(root);
    return files;
}

test('backup -> token -> restore round-trip with a stubbed Telegram transport', async () => {
    const work = tempDir();
    const source = path.join(work, 'source');
    const store = path.join(work, 'store');
    const tmpDir = path.join(work, 'tmp');
    fs.mkdirSync(store, { recursive: true });
    writeTree(source);

    const masterKeyPath = path.join(work, 'master.key');
    fs.writeFileSync(masterKeyPath, `${generateMasterKey()}\n`, { mode: 0o600 });

    // Stub the Telegram transport before loading the commands.
    const telegramPath = require.resolve('../src/telegram');
    const stored = new Map();
    let nextId = 215;
    require.cache[telegramPath] = {
        id: telegramPath,
        filename: telegramPath,
        loaded: true,
        exports: {
            async connect() {
                return {};
            },
            async closeClient() {},
            async uploadDocument(_client, options) {
                const destination = path.join(store, `message-${nextId}`);
                fs.copyFileSync(options.filePath, destination);
                const message = { id: nextId };
                stored.set(nextId, { path: destination, size: options.size });
                nextId += 1;
                return message;
            },
            async downloadDocument(_client, options) {
                const entry = stored.get(options.messageId);
                if (!entry) throw new Error(`no stubbed message ${options.messageId}`);
                fs.copyFileSync(entry.path, options.outputPath);
                if (options.onProgress) options.onProgress(entry.size, entry.size);
                return {};
            },
        },
    };

    const { runBackup } = require('../src/backup');
    const { runRestore } = require('../src/restore');

    const config = {
        apiId: 1,
        apiHash: 'a'.repeat(32),
        target: '-1001',
        prefix: 'test',
        partSize: 256 * 1024,
        zstdLevel: 3,
        uploadDelay: { minMs: 0, maxMs: 0 },
        premium: false,
        tmpDir,
        masterKeyFile: masterKeyPath,
        masterKey: undefined,
        sessionFile: path.join(work, 'session.txt'),
        session: null,
        proxy: null,
    };

    const token = await runBackup(config, { path: path.join(source, 'data'), keepTmp: false, interactive: false });

    const decoded = decodeToken(token);
    assert.ok(decoded.parts.length > 1, 'payload should span multiple parts');
    assert.equal(decoded.root, 'data');
    assert.equal(decoded.key.length, 32);

    const destination = path.join(work, 'restored');
    await runRestore(config, { token, out: destination, keepTmp: false, interactive: false });

    const original = readTree(path.join(source, 'data'));
    const restored = readTree(path.join(destination, 'data'));
    assert.deepEqual(Object.keys(restored).sort(), Object.keys(original).sort());
    for (const name of Object.keys(original)) {
        assert.deepEqual(restored[name], original[name], `content mismatch for ${name}`);
    }

    // A different master key must not be able to decrypt the parts.
    const wrongKeyPath = path.join(work, 'wrong.key');
    fs.writeFileSync(wrongKeyPath, `${generateMasterKey()}\n`, { mode: 0o600 });
    await assert.rejects(
        runRestore(
            { ...config, masterKeyFile: wrongKeyPath },
            { token, out: path.join(work, 'wrong-restore'), keepTmp: false, interactive: false },
        ),
        /cannot decrypt part/,
    );

    fs.rmSync(work, { recursive: true, force: true });
});
