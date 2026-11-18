'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { buildClientParams, checkTcp, downloadDocument, uploadDocument } = require('../src/telegram');

test('checkTcp accepts a reachable port and rejects a closed one', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    await checkTcp('127.0.0.1', port, 1000);

    await new Promise((resolve) => server.close(resolve));
    await assert.rejects(checkTcp('127.0.0.1', port, 1000));
});

test('uploadDocument forwards workers and converts GramJS progress fractions to percents', async () => {
    const seen = [];
    const client = {
        uploadFile: async (params) => {
            assert.equal(params.workers, 2);
            assert.equal(params.file.size, 10);
            params.onProgress(0);
            params.onProgress(0.123);
            params.onProgress(1);
            return { _: 'InputFile' };
        },
        sendFile: async () => ({ id: 42 }),
    };

    const message = await uploadDocument(client, {
        target: '-1001234',
        filePath: '/tmp/not-read-by-this-test',
        fileName: 'part.tgbk',
        size: 10,
        caption: 'tgbackup test [1/2]',
        workers: 2,
        onProgress: (percent) => seen.push(percent),
    });

    assert.equal(seen[0], 0);
    assert.equal(seen[1].toFixed(1), '12.3');
    assert.equal(seen[2], 100);
    assert.equal(message.id, 42);
});

const CHUNK = 512 * 1024;

function stubMessage(size, dcId) {
    return {
        media: {
            document: {
                id: 5,
                accessHash: 6,
                fileReference: Buffer.from('file-reference'),
                size,
                ...(dcId === undefined ? {} : { dcId }),
            },
        },
    };
}

/** Stub helpers for the manual sender pool (created via gramjs internals). */
function poolStubs() {
    const created = { list: [], disconnects: 0 };
    return {
        created,
        _createExportedSender(dcId) {
            created.list.push(dcId);
            return {
                dcId,
                isConnected: () => true,
                async disconnect() {
                    created.disconnects += 1;
                },
            };
        },
        async _connectSender(_sender, _dcId) {},
    };
}

test('downloadDocument pulls 512 KiB chunks in parallel and writes them at their offsets', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-parallel-'));
    const outputPath = path.join(work, 'part.enc');
    const SIZE = CHUNK * 2 + 10; // two full chunks plus a short tail

    const seenRequests = [];
    const client = {
        disconnected: false,
        async getMessages() {
            return [stubMessage(SIZE, 2)];
        },
        async invokeWithSender(request, sender) {
            seenRequests.push({ request, sender });
            const offset = Number(request.offset);
            const length = Math.min(CHUNK, SIZE - offset);
            const chunk = offset / CHUNK;
            return { bytes: Buffer.alloc(length, chunk + 1) }; // fill byte marks the chunk index
        },
        async disconnect() {},
        ...poolStubs(),
    };

    const progress = [];
    await downloadDocument(client, {
        target: '-1001',
        messageId: 11,
        outputPath,
        senders: 2,
        workersPerSender: 2,
        onProgress: (received, total) => progress.push([received, total]),
    });

    assert.deepEqual(client.created.list, [2, 2], 'senders options requests one dedicated sender per line');
    assert.equal(client.created.disconnects, 2, 'owned senders must be disconnected after the download');
    assert.equal(fs.statSync(outputPath).size, SIZE, 'the file must be exactly the document size');
    assert.deepEqual(
        seenRequests.map((entry) => Number(entry.request.offset)).sort((a, b) => a - b),
        [0, CHUNK, 2 * CHUNK],
        'chunks must cover the document from offset 0 with a shared queue',
    );
    for (const { request } of seenRequests) {
        assert.equal(request.limit, CHUNK, 'every GetFile request must use the 512 KiB chunk size');
    }

    const fd = fs.openSync(outputPath, 'r');
    try {
        for (const offset of [0, CHUNK, 2 * CHUNK]) {
            const byte = Buffer.alloc(1);
            fs.readSync(fd, byte, 0, 1, offset);
            assert.equal(byte[0], offset / CHUNK + 1, `chunk data must land at offset ${offset}`);
        }
    } finally {
        fs.closeSync(fd);
    }
    assert.deepEqual(progress[progress.length - 1], [SIZE, SIZE], 'progress must reach the full size');

    fs.rmSync(work, { recursive: true, force: true });
});

test('downloadDocument handles FLOOD_WAIT by sleeping and retrying the chunk', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { errors } = require('telegram');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-flood-'));
    const outputPath = path.join(work, 'part.enc');

    let attempts = 0;
    const client = {
        disconnected: false,
        async getMessages() {
            return [stubMessage(CHUNK, 2)];
        },
        async invokeWithSender() {
            attempts += 1;
            if (attempts === 1) {
                throw Object.assign(new errors.FloodWaitError({}), { seconds: 1 });
            }
            return { bytes: Buffer.alloc(CHUNK, 7) };
        },
        async disconnect() {},
        ...poolStubs(),
    };

    await downloadDocument(client, {
        target: '-1001',
        messageId: 12,
        outputPath,
        senders: 1,
        workersPerSender: 1,
    });

    assert.deepEqual(client.created.list, [2], 'one dedicated sender for senders: 1');
    assert.equal(attempts, 2, 'the flooded chunk must be retried after the wait');
    assert.equal(fs.statSync(outputPath).size, CHUNK);
    assert.equal(client.created.disconnects, 1, 'the sender must be released afterwards');
    fs.rmSync(work, { recursive: true, force: true });
});

test('downloadDocument follows FileMigrateError and rebuilds the pool in the new DC', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { errors } = require('telegram');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-migrate-'));
    const outputPath = path.join(work, 'part.enc');

    // the media predates the dc_id field, so the DC is unknown at first and
    // the chunks start on the main client sender
    const borrowedDcs = [];
    const invokedWith = [];
    let migrated = false;
    const client = {
        disconnected: false,
        async getMessages() {
            return [stubMessage(CHUNK, undefined)];
        },
        async getSender(dcId) {
            borrowedDcs.push(dcId);
            return {
                dcId,
                isConnected: () => true,
                async disconnect() {},
            };
        },
        async invokeWithSender(_request, sender) {
            invokedWith.push(sender.dcId);
            if (!migrated) {
                migrated = true;
                throw Object.assign(new errors.FileMigrateError({}), { newDc: 4 });
            }
            return { bytes: Buffer.alloc(CHUNK, 9) };
        },
        async disconnect() {},
        ...poolStubs(),
    };

    await downloadDocument(client, {
        target: '-1001',
        messageId: 13,
        outputPath,
        senders: 2,
        workersPerSender: 1,
    });

    assert.deepEqual(borrowedDcs, [undefined], 'the first chunks must ride the main sender (unknown DC)');
    // one chunk only: the worker retries it on a dedicated sender in DC 4
    assert.deepEqual(invokedWith, [undefined, 4], 'must move to dedicated senders in the migrated DC');
    assert.deepEqual(client.created.list, [4, 4], 'the pool must be rebuilt in DC 4');
    assert.equal(client.created.disconnects, 2, 'the rebuilt senders must be released afterwards');
    assert.equal(fs.statSync(outputPath).size, CHUNK);
    fs.rmSync(work, { recursive: true, force: true });
});

test('downloadDocument kills a stalled download, disconnects senders and removes the partial file', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stall-'));
    const outputPath = path.join(work, 'part.enc');

    let connectedCalled = 0;
    let disconnectedCalled = 0;
    const client = {
        disconnected: true, // simulate a previous stall having killed the senders
        async connect() {
            connectedCalled += 1;
        },
        async getMessages() {
            return [stubMessage(CHUNK, 2)];
        },
        async invokeWithSender() {
            return new Promise(() => {}); // never finishes; watchdog must fire
        },
        async disconnect() {
            disconnectedCalled += 1;
        },
        ...poolStubs(),
    };

    const watchdog = downloadDocument(client, {
        target: '-1001',
        messageId: 7,
        outputPath,
        senders: 2,
        workersPerSender: 1,
        stallTimeoutMs: 60, // tiny so the test is fast (checked every ~50ms)
    });
    await assert.rejects(watchdog, /download stalled/);
    assert.equal(connectedCalled, 1, 'must reconnect before starting the download');
    assert.equal(disconnectedCalled, 1, 'the client must be killed after a stall');
    assert.deepEqual(client.created.list, [2, 2], 'two dedicated senders must be created');
    // kill path releases the pool; the cleanup afterwards double-releases
    // the dead senders (gramjs tolerates repeat disconnects)
    assert.ok(client.created.disconnects >= 2, 'the owned senders must also be killed');
    assert.ok(!fs.existsSync(outputPath), 'partial file must be removed');
    fs.rmSync(work, { recursive: true, force: true });
});

test('the SOCKS proxy is passed to GramJS in its native shape', () => {
    const params = buildClientParams({
        proxy: {
            type: 'socks5',
            host: '127.0.0.1',
            port: 1080,
            username: 'user',
            password: 'pass',
            timeout: 30,
        },
    });

    assert.deepEqual(params.proxy, {
        ip: '127.0.0.1',
        port: 1080,
        socksType: 5,
        username: 'user',
        password: 'pass',
        timeout: 30,
    });

    const socks4 = buildClientParams({ proxy: { type: 'socks4', host: 'proxy', port: 9050 } });
    assert.equal(socks4.proxy.socksType, 4);

    const direct = buildClientParams({ proxy: null });
    assert.equal(direct.proxy, undefined);
});
