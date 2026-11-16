'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { protectStdout } = require('../src/log');

test('protectStdout turns GramJS keep-alive TIMEOUT spam into a throttled note', () => {
    const captured = [];
    const original = console.error;
    console.error = (...args) => captured.push(args);
    const restore = protectStdout();

    try {
        const ping = new Error('TIMEOUT');
        ping.stack = `${ping.stack}\n    at _updateLoop (/x/node_modules/telegram/client/updates.js:250:85)`;
        console.error(ping);
        console.error(ping); // must be throttled away
        console.error(new Error('FLOOD_WAIT_5')); // unrelated errors pass through
    } finally {
        restore();
    }

    const notes = captured.filter((args) => typeof args[0] === 'string' && args[0].includes('keep-alive'));
    const passed = captured.filter((args) => args[0] instanceof Error && args[0].message !== 'TIMEOUT');
    assert.equal(notes.length, 1, 'repeated ping timeouts must produce exactly one note');
    assert.equal(passed.length, 1, 'unrelated errors must not be swallowed');
    console.error = original;
});

test('protectStdout does not redirect console.error into itself', () => {
    const restore = protectStdout();
    try {
        console.error('plain message');
    } finally {
        restore();
    }
});
