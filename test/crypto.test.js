'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const test = require('node:test');

const {
    FrameEncryptor,
    FrameDecryptor,
    encryptFile,
    encryptBufferToFile,
    decryptFile,
} = require('../src/crypto');
const { encodeToken, decodeToken } = require('../src/token');
const { createArchiveStream, createDecompressorStream, createExtractStream } = require('../src/archive');

function* slices(buffer, size) {
    for (let offset = 0; offset < buffer.length; offset += size) {
        yield buffer.subarray(offset, Math.min(offset + size, buffer.length));
    }
}

async function transformBuffer(buffer, transformer) {
    const output = [];
    const sink = new Writable({
        write(chunk, _encoding, callback) {
            output.push(chunk);
            callback();
        },
    });
    await pipeline(Readable.from(slices(buffer, 65536)), transformer, sink);
    return Buffer.concat(output);
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tgbackup-test-'));
}

test('framed encryption round-trips across many frames', async () => {
    const key = crypto.randomBytes(32);
    const data = crypto.randomBytes(9 * 1024 * 1024 + 12345);

    const encrypted = await transformBuffer(data, new FrameEncryptor(key, { frameSize: 256 * 1024 }));
    assert.notDeepEqual(encrypted, data);
    assert.ok(encrypted.length > data.length);

    const decrypted = await transformBuffer(encrypted, new FrameDecryptor(key));
    assert.deepEqual(decrypted, data);
});

test('decryption rejects a tampered frame', async () => {
    const key = crypto.randomBytes(32);
    const data = crypto.randomBytes(512 * 1024);
    const encrypted = await transformBuffer(data, new FrameEncryptor(key, { frameSize: 64 * 1024 }));
    encrypted[encrypted.length - 5] ^= 0xff;

    await assert.rejects(transformBuffer(encrypted, new FrameDecryptor(key)));
});

test('decryption rejects the wrong key', async () => {
    const data = crypto.randomBytes(128 * 1024);
    const encrypted = await transformBuffer(data, new FrameEncryptor(crypto.randomBytes(32)));

    await assert.rejects(transformBuffer(encrypted, new FrameDecryptor(crypto.randomBytes(32))));
});

test('two-layer file encryption requires both keys', async () => {
    const dir = tempDir();
    const inner = crypto.randomBytes(32);
    const outer = crypto.randomBytes(32);
    const plainPath = path.join(dir, 'plain.bin');
    const encryptedPath = path.join(dir, 'plain.enc');
    const decryptedPath = path.join(dir, 'plain.dec');
    const data = crypto.randomBytes(700 * 1024);

    fs.writeFileSync(plainPath, data);
    await encryptFile(plainPath, encryptedPath, [inner, outer], { frameSize: 128 * 1024 });

    await assert.rejects(
        decryptFile(encryptedPath, decryptedPath, [crypto.randomBytes(32), outer], { frameSize: 128 * 1024 }),
    );

    await decryptFile(encryptedPath, decryptedPath, [inner, outer], { frameSize: 128 * 1024 });
    assert.deepEqual(fs.readFileSync(decryptedPath), data);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('buffer encryption matches file decryption', async () => {
    const dir = tempDir();
    const key = crypto.randomBytes(32);
    const data = crypto.randomBytes(300 * 1024);
    const encryptedPath = path.join(dir, 'buffer.enc');
    const decryptedPath = path.join(dir, 'buffer.dec');

    await encryptBufferToFile(data, encryptedPath, [key], { frameSize: 64 * 1024 });
    await decryptFile(encryptedPath, decryptedPath, [key], { frameSize: 64 * 1024 });

    assert.deepEqual(fs.readFileSync(decryptedPath), data);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('token round-trips and carries ids, sizes, key and the backup chat', () => {
    const key = crypto.randomBytes(32);
    const token = encodeToken({
        name: 'backup-test',
        createdAt: '2026-11-16T00:00:00.000Z',
        root: 'data',
        key,
        parts: [
            { id: 215, size: 1024 },
            { id: 216, size: 2048 },
        ],
        chat: '-1001234567890',
    });

    assert.match(token, /^[A-Za-z0-9_-]+$/);
    const decoded = decodeToken(token);
    assert.equal(decoded.version, 2, 'new tokens are msgpack v2');
    assert.equal(decoded.name, 'backup-test');
    assert.equal(decoded.createdAt, '2026-11-16T00:00:00.000Z');
    assert.equal(decoded.root, 'data');
    assert.equal(decoded.chat, '-1001234567890');
    assert.deepEqual(decoded.key, key);
    assert.deepEqual(decoded.parts, [
        { id: 215, size: 1024 },
        { id: 216, size: 2048 },
    ]);
});

test('legacy JSON tokens (v1, no chat) still decode', () => {
    const legacy = Buffer.from(JSON.stringify({
        v: 1,
        n: 'old-backup',
        t: '2025-01-01T00:00:00Z',
        r: 'srv',
        k: crypto.randomBytes(32).toString('base64url'),
        p: [{ i: 42, s: 1337 }],
    })).toString('base64url');

    const decoded = decodeToken(legacy);
    assert.equal(decoded.version, 1);
    assert.equal(decoded.name, 'old-backup');
    assert.equal(decoded.createdAt, '2025-01-01T00:00:00Z');
    assert.equal(decoded.root, 'srv');
    assert.equal(decoded.chat, null);
    assert.equal(decoded.key.length, 32);
    assert.deepEqual(decoded.parts, [{ id: 42, size: 1337 }]);
});

test('encodeToken requires the backup chat id', () => {
    const key = crypto.randomBytes(32);
    assert.throws(
        () => encodeToken({ name: 'x', key, parts: [{ id: 1, size: 1 }] }),
        /without the target chat id/,
    );
});

test('token decoding rejects invalid input', () => {
    assert.throws(() => decodeToken(''), /missing backup token/);
    assert.throws(() => decodeToken('not-a-token'), /invalid backup token/);
    const noParts = Buffer.from(JSON.stringify({ v: 1, k: crypto.randomBytes(32).toString('base64url'), p: [] })).toString('base64url');
    assert.throws(() => decodeToken(noParts), /no parts/);
});

test('zstd tar archive round-trips a directory', async () => {
    const source = tempDir();
    const destination = tempDir();
    fs.mkdirSync(path.join(source, 'data', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'data', 'a.txt'), 'hello zstd');
    fs.writeFileSync(path.join(source, 'data', 'nested', 'b.bin'), crypto.randomBytes(256 * 1024));

    const archivePath = path.join(source, 'archive.tar.zst');
    fs.writeFileSync(archivePath, Buffer.alloc(0));
    await pipeline(createArchiveStream(path.join(source, 'data'), { level: 5 }), fs.createWriteStream(archivePath));

    await pipeline(
        fs.createReadStream(archivePath),
        createDecompressorStream(),
        createExtractStream(destination),
    );

    assert.equal(fs.readFileSync(path.join(destination, 'data', 'a.txt'), 'utf8'), 'hello zstd');
    assert.deepEqual(
        fs.readFileSync(path.join(destination, 'data', 'nested', 'b.bin')),
        fs.readFileSync(path.join(source, 'data', 'nested', 'b.bin')),
    );

    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
});
