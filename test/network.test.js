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

test('downloadDocument kills a stalled download, disconnects and removes the partial file', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
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
            return [{ media: {} }];
        },
        async downloadMedia() {
            return new Promise(() => {}); // never finishes; watchdog must fire
        },
        async disconnect() {
            disconnectedCalled += 1;
        },
    };

    const watchdog = downloadDocument(client, {
        target: '-1001',
        messageId: 7,
        outputPath,
        stallTimeoutMs: 60, // tiny so the test is fast (checked every ~50ms)
    });
    await assert.rejects(watchdog, /download stalled.*60s|download stalled/);
    assert.equal(connectedCalled, 1, 'must reconnect before starting the download');
    assert.equal(disconnectedCalled, 1, 'senders must be killed after a stall');
    assert.ok(!fs.existsSync(outputPath), 'partial file must be removed');
    fs.rmSync(work, { recursive: true, force: true });
});

test('downloadDocument without a watchdog waits for downloadMedia to finish', async () => {
    let progressSeen = [];
    const client = {
        disconnected: false,
        async getMessages() {
            return [{ media: {} }];
        },
        async disconnect() {},
        async downloadMedia(_message, { progressCallback }) {
            progressCallback('100', '200'); // GramJS passes big-integer-like values
            return 'done';
        },
    };

    const message = await downloadDocument(client, {
        target: '-1001',
        messageId: 9,
        outputPath: '/tmp/unused',
        onProgress: (received, total) => progressSeen.push([received, total]),
    });
    assert.deepEqual(progressSeen, [[100, 200]]);
    assert.deepEqual(message, { media: {} });
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
