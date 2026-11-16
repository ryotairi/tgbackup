'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { UsageError, warnIfLoosePermissions } = require('./util');

const KEY_LENGTH = 32;
const HKDF_SALT = Buffer.from('tgbackup/master-key/v1', 'utf8');
const HKDF_INFO = Buffer.from('tgbackup aes-256-gcm master key', 'utf8');

/**
 * Accepts a master secret in any of these forms:
 *  - 64 hex characters
 *  - 32-byte base64 / base64url (as produced by `tgbackup init`)
 *  - any other text, used verbatim as a passphrase
 */
function parseSecret(input) {
    const text = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input)).trim();
    if (!text) throw new UsageError('master key is empty');

    if (/^[0-9a-fA-F]{64}$/.test(text)) {
        return Buffer.from(text, 'hex');
    }
    if (/^[A-Za-z0-9+/_-]{43}=*$/.test(text)) {
        const decoded = Buffer.from(text, 'base64url');
        if (decoded.length === KEY_LENGTH) return decoded;
    }
    if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
        const decoded = Buffer.from(text, 'base64');
        if (decoded.length === KEY_LENGTH) return decoded;
    }
    return Buffer.from(text, 'utf8');
}

/** Stretch an arbitrary secret into a stable 32-byte key with HKDF-SHA256. */
function deriveMasterKey(secret) {
    const raw = parseSecret(secret);
    return Buffer.from(crypto.hkdfSync('sha256', raw, HKDF_SALT, HKDF_INFO, KEY_LENGTH));
}

/** Generate a fresh master key in the canonical on-disk format. */
function generateMasterKey() {
    return crypto.randomBytes(KEY_LENGTH).toString('base64url');
}

function loadMasterKey(config) {
    if (config.masterKey) {
        return deriveMasterKey(config.masterKey);
    }

    const file = config.masterKeyFile;
    if (!file || !fs.existsSync(file)) {
        throw new UsageError(
            `master key not found${file ? ` at ${file}` : ''}; run "tgbackup init" or set TGBACKUP_MASTER_KEY`,
        );
    }

    const warning = warnIfLoosePermissions(file);
    if (warning) console.error(warning);

    return deriveMasterKey(fs.readFileSync(file));
}

module.exports = {
    KEY_LENGTH,
    parseSecret,
    deriveMasterKey,
    generateMasterKey,
    loadMasterKey,
};
