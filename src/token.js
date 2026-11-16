'use strict';

const { UsageError } = require('./util');

const TOKEN_VERSION = 1;
const KEY_LENGTH = 32;

/**
 * The token is a self-contained base64url blob with everything needed to find
 * and unwrap a backup, except the master key:
 *
 *   v  token format version
 *   n  backup name
 *   t  ISO timestamp
 *   r  archive root entry (original file/directory name)
 *   k  random per-backup key (base64url, 32 bytes)
 *   p  parts: [{ i: Telegram message id, s: encrypted size in bytes }]
 */
function encodeToken({ name, createdAt, root, key, parts }) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new Error('backup key must be a 32-byte Buffer');
    }
    if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error('cannot encode a token without parts');
    }
    const payload = {
        v: TOKEN_VERSION,
        n: name,
        t: createdAt,
        r: root,
        k: key.toString('base64url'),
        p: parts.map((part) => ({ i: part.id, s: part.size })),
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeToken(input) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new UsageError('missing backup token');
    }
    const text = input.trim();
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
        throw new UsageError('invalid backup token: expected a base64url-encoded JSON blob');
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    } catch {
        throw new UsageError('invalid backup token: expected a base64url-encoded JSON blob');
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new UsageError('invalid backup token: payload is not an object');
    }
    if (payload.v !== TOKEN_VERSION) {
        throw new UsageError(`unsupported backup token version: ${payload.v}`);
    }
    if (typeof payload.k !== 'string') {
        throw new UsageError('invalid backup token: missing key');
    }

    let key;
    try {
        key = Buffer.from(payload.k, 'base64url');
    } catch {
        throw new UsageError('invalid backup token: key is not base64url');
    }
    if (key.length !== KEY_LENGTH) {
        throw new UsageError(`invalid backup token: key must be ${KEY_LENGTH} bytes`);
    }

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

    return {
        version: payload.v,
        name: typeof payload.n === 'string' && payload.n ? payload.n : 'backup',
        createdAt: typeof payload.t === 'string' ? payload.t : null,
        root: typeof payload.r === 'string' ? payload.r : null,
        key,
        parts,
    };
}

module.exports = {
    TOKEN_VERSION,
    encodeToken,
    decodeToken,
};
