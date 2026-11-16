'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeProxy, normalizeUploadDelay, normalizeConfig } = require('../src/config');

const baseRaw = {
    telegram: {
        api_id: 123456,
        api_hash: 'a'.repeat(32),
        channel: '-1001234567890',
    },
};

test('proxy URL parsing supports SOCKS5 with credentials', () => {
    const proxy = normalizeProxy('socks5://user:p%40ss@127.0.0.1:1080');
    assert.deepEqual(proxy, {
        type: 'socks5',
        host: '127.0.0.1',
        port: 1080,
        username: 'user',
        password: 'p@ss',
        timeout: 10,
    });
});

test('proxy object parsing supports socks4 and disabling', () => {
    assert.deepEqual(normalizeProxy({ type: 'socks4', host: 'proxy', port: 9050 }), {
        type: 'socks4',
        host: 'proxy',
        port: 9050,
        username: undefined,
        password: undefined,
        timeout: 10,
    });
    assert.equal(normalizeProxy({ enabled: false, host: 'proxy', port: 9050 }), null);
    assert.throws(() => normalizeProxy('http://proxy:8080'), /unsupported proxy scheme/);
});

test('upload delay accepts ranges and single values', () => {
    assert.deepEqual(normalizeUploadDelay({ min: 1, max: 3 }), { minMs: 1000, maxMs: 3000 });
    assert.deepEqual(normalizeUploadDelay(0), { minMs: 0, maxMs: 0 });
    assert.throws(() => normalizeUploadDelay({ min: 5, max: 1 }), /must not exceed/);
});

test('part size is validated against account limits', () => {
    assert.throws(
        () => normalizeConfig({ ...baseRaw, part_size: 3 * 1024 ** 3 }, { configPath: '/tmp/x', baseDir: '/tmp' }),
        /exceeds the 2 GiB limit/,
    );

    const premium = normalizeConfig(
        { ...baseRaw, part_size: 3 * 1024 ** 3, telegram: { ...baseRaw.telegram, premium: true } },
        { configPath: '/tmp/x', baseDir: '/tmp' },
    );
    assert.equal(premium.partSize, 3 * 1024 ** 3);
});

test('config exposes resolved paths and defaults', () => {
    const config = normalizeConfig(baseRaw, { configPath: '/tmp/dir/config.yml', baseDir: '/tmp/dir' });
    assert.equal(config.partSize, 256 * 1024 * 1024);
    assert.equal(config.zstdLevel, 10);
    assert.equal(config.masterKeyFile, '/tmp/dir/master.key');
    assert.equal(config.sessionFile, '/tmp/dir/session.txt');
    assert.equal(config.proxy, null);
});
