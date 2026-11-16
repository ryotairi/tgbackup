'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { buildClientParams, checkTcp, uploadDocument } = require('../src/telegram');

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

test('the SOCKS proxy is passed to GramJS in its native shape', () => {
    const params = buildClientParams({
        proxy: {
            type: 'socks5',
            host: '127.0.0.1',
            port: 1080,
            username: 'user',
            password: 'pass',
            timeout: 10,
        },
    });

    assert.deepEqual(params.proxy, {
        ip: '127.0.0.1',
        port: 1080,
        socksType: 5,
        username: 'user',
        password: 'pass',
        timeout: 10,
    });

    const socks4 = buildClientParams({ proxy: { type: 'socks4', host: 'proxy', port: 9050 } });
    assert.equal(socks4.proxy.socksType, 4);

    const direct = buildClientParams({ proxy: null });
    assert.equal(direct.proxy, undefined);
});
