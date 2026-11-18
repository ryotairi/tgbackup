'use strict';

const { decode: unpack, encode: pack } = require('@msgpack/msgpack');
const { UsageError } = require('./util');

const TOKEN_VERSION = 2; // MessagePack payload, includes the backup chat id
const LEGACY_TOKEN_VERSION = 1; // original JSON payload (no chat id)
const KEY_LENGTH = 32;

/**
 * Token format v2: base64url(MessagePack). Short keys keep the blob compact:
 *
 *   v  format version (2)
 *   n  backup name
 *   t  ISO timestamp
 *   r  archive root entry (original file/directory name)
 *   k  random per-backup key (32 raw bytes, msgpack bin)
 *   p  parts: [{ i: Telegram message id, s: encrypted size in bytes }]
 *   c  chat id the parts were uploaded to (used by restore; not by backup)
 *
 * The token is self-contained except for the master key. Tokens v1 (JSON,
 * same field names, no `c`) still decode; restores then fall back to the chat
 * configured in config.yml.
 */
function encodeToken({ name, createdAt, root, key, parts, chat }) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new Error('backup key must be a 32-byte Buffer');
    }
    if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error('cannot encode a token without parts');
    }
    if (chat === undefined || chat === null || String(chat).trim() === '') {
        throw new Error('cannot encode a token without the target chat id');
    }

    const payload = {
        v: TOKEN_VERSION,
        n: typeof name === 'string' && name ? name : 'backup',
        t: typeof createdAt === 'string' ? createdAt : null,
        r: typeof root === 'string' ? root : null,
        k: key,
        p: parts.map((part) => ({ i: part.id, s: part.size })),
        c: String(chat).trim(),
    };
    return Buffer.from(pack(payload)).toString('base64url');
}

function requireObject(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new UsageError('invalid backup token: payload is not an object');
    }
}

function parseKey(rawKey) {
    if (rawKey instanceof Uint8Array) {
        const key = Buffer.from(rawKey);
        if (key.length !== KEY_LENGTH) {
            throw new UsageError(`invalid backup token: key must be ${KEY_LENGTH} bytes`);
        }
        return key;
    }
    if (typeof rawKey === 'string') {
        let key;
        try {
            key = Buffer.from(rawKey, 'base64url');
        } catch {
            throw new UsageError('invalid backup token: key is not base64url');
        }
        if (key.length !== KEY_LENGTH) {
            throw new UsageError(`invalid backup token: key must be ${KEY_LENGTH} bytes`);
        }
        return key;
    }
    throw new UsageError('invalid backup token: missing key');
}

function decodeToken(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new UsageError('missing backup token');
    }
    const text = input.trim();
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
        throw new UsageError('invalid backup token: expected a base64url-encoded token');
    }

    const bytes = Buffer.from(text, 'base64url');

    // v1 tokens are JSON text and start with '{'; v2 tokens are MessagePack
    // and start with a map header (0x8x range).
    let payload;
    if (bytes[0] === 0x7b) {
        try {
            payload = JSON.parse(bytes.toString('utf8'));
        } catch {
            throw new UsageError('invalid backup token: expected a base64url-encoded token');
        }
        requireObject(payload);
        if (payload.v !== LEGACY_TOKEN_VERSION) {
            throw new UsageError(`unsupported backup token version: ${payload.v}`);
        }
    } else {
        try {
            payload = unpack(bytes);
        } catch {
            throw new UsageError('invalid backup token: expected a base64url-encoded token');
        }
        requireObject(payload);
        if (payload.v !== TOKEN_VERSION) {
            throw new UsageError(`unsupported backup token version: ${payload.v}`);
        }
    }

    const key = parseKey(payload.k);

    if (!Array.isArray(payload.p) || payload.p.length === 0) {
        throw new UsageError('invalid backup token: no parts');
    }
    const parts = payload.p.map((part, index) => {
        if (!part || typeof part !== 'object') {
            throw new UsageError(`invalid backup token: bad part #${index + 1}`);
        }
        const id = Number(part.i);
        const size = Number(part.s);
        if (!Number.isInteger(id) || id <= 0) {
            throw new UsageError(`invalid backup token: bad message id for part #${index + 1}`);
        }
        if (!Number.isInteger(size) || size < 0) {
            throw new UsageError(`invalid backup token: bad size for part #${index + 1}`);
        }
        return { id, size };
    });

    const chatValue = payload.c;
    const chat = typeof chatValue === 'string' && chatValue.trim() ? chatValue.trim() : null;

    return {
        version: payload.v,
        name: typeof payload.n === 'string' && payload.n ? payload.n : 'backup',
        createdAt: typeof payload.t === 'string' ? payload.t : null,
        root: typeof payload.r === 'string' ? payload.r : null,
        key,
        parts,
        chat,
    };
}

module.exports = {
    TOKEN_VERSION,
    LEGACY_TOKEN_VERSION,
    encodeToken,
    decodeToken,
};
