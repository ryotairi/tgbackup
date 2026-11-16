'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const LENGTH_FIELD = 4;
const HEADER_LENGTH = 13; // magic(4) + version(1) + nonce prefix(8)
const MAGIC = Buffer.from('TGBK', 'ascii');
const VERSION = 1;

/** Default plaintext bytes per AEAD frame (4 MiB). Each frame carries its own tag. */
const DEFAULT_FRAME_SIZE = 4 * 1024 * 1024;
/** Sanity bound while decoding, protects against corrupted length fields. */
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

class ByteQueue {
    constructor() {
        this.parts = [];
        this.length = 0;
    }

    push(buffer) {
        if (buffer.length > 0) {
            this.parts.push(buffer);
            this.length += buffer.length;
        }
    }

    /** Consume exactly n bytes (zero copy when the head chunk is large enough). */
    take(n) {
        if (this.length < n) return null;
        const first = this.parts[0];
        if (first.length > n) {
            this.parts[0] = first.subarray(n);
            this.length -= n;
            return first.subarray(0, n);
        }
        if (first.length === n) {
            this.parts.shift();
            this.length -= n;
            return first;
        }
        const out = Buffer.allocUnsafe(n);
        let filled = 0;
        while (filled < n) {
            const head = this.parts[0];
            const need = n - filled;
            if (head.length <= need) {
                head.copy(out, filled);
                filled += head.length;
                this.parts.shift();
            } else {
                head.copy(out, filled, 0, need);
                this.parts[0] = head.subarray(need);
                filled = n;
            }
        }
        this.length -= n;
        return out;
    }

    /** Look at the next n bytes without consuming them. */
    peek(n) {
        if (this.length < n) return null;
        const first = this.parts[0];
        if (first.length >= n) return first.subarray(0, n);
        const out = Buffer.allocUnsafe(n);
        let filled = 0;
        for (const part of this.parts) {
            const need = n - filled;
            if (need <= 0) break;
            if (part.length <= need) {
                part.copy(out, filled);
                filled += part.length;
            } else {
                part.copy(out, filled, 0, need);
                filled = n;
            }
        }
        return out;
    }
}

function assertKey(key) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new Error(`encryption key must be a ${KEY_LENGTH}-byte Buffer`);
    }
    return key;
}

function makeNonce(prefix, counter) {
    if (counter > 0xffffffff) throw new Error('frame counter overflow');
    const nonce = Buffer.allocUnsafe(NONCE_LENGTH);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(counter, 8);
    return nonce;
}

function buildHeader() {
    const header = Buffer.allocUnsafe(HEADER_LENGTH);
    MAGIC.copy(header, 0);
    header.writeUInt8(VERSION, 4);
    crypto.randomFillSync(header, 5, 8);
    return header;
}

/**
 * Transform: plaintext -> framed AES-256-GCM ciphertext.
 * Layout: header || (frame_len:u32be || nonce:12 || tag:16 || ciphertext)*
 */
class FrameEncryptor extends Transform {
    constructor(key, options = {}) {
        super();
        this.key = assertKey(key);
        this.frameSize = options.frameSize || DEFAULT_FRAME_SIZE;
        this.header = buildHeader();
        this.prefix = this.header.subarray(5, 13);
        this.counter = 0;
        this.headerPushed = false;
        this.queue = new ByteQueue();
    }

    _pushHeader() {
        if (!this.headerPushed) {
            this.headerPushed = true;
            this.push(this.header);
        }
    }

    _transform(chunk, _encoding, callback) {
        try {
            this._pushHeader();
            this.queue.push(chunk);
            while (this.queue.length >= this.frameSize) {
                this._encryptFrame(this.queue.take(this.frameSize));
            }
            callback();
        } catch (error) {
            callback(error);
        }
    }

    _flush(callback) {
        try {
            this._pushHeader();
            if (this.queue.length > 0) {
                this._encryptFrame(this.queue.take(this.queue.length));
            }
            callback();
        } catch (error) {
            callback(error);
        }
    }

    _encryptFrame(plaintext) {
        const nonce = makeNonce(this.prefix, this.counter);
        this.counter += 1;
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, nonce, { authTagLength: TAG_LENGTH });
        cipher.setAAD(this.header);
        const ciphertext = cipher.update(plaintext);
        const tail = cipher.final();
        const tag = cipher.getAuthTag();

        // Push the frame pieces separately: no file-sized (or even frame-sized)
        // intermediate copy of the ciphertext is made here.
        const lengthBytes = Buffer.allocUnsafe(LENGTH_FIELD);
        lengthBytes.writeUInt32BE(plaintext.length, 0);
        this.push(lengthBytes);
        this.push(nonce);
        this.push(tag);
        this.push(ciphertext);
        if (tail.length > 0) this.push(tail);
    }
}

/** Transform: framed AES-256-GCM ciphertext -> plaintext. Verifies every frame. */
class FrameDecryptor extends Transform {
    constructor(key, options = {}) {
        super();
        this.key = assertKey(key);
        this.maxFrameSize = options.maxFrameSize || MAX_FRAME_SIZE;
        this.header = null;
        this.frameLength = null;
        this.queue = new ByteQueue();
    }

    _transform(chunk, _encoding, callback) {
        try {
            this.queue.push(chunk);
            this._drain();
            callback();
        } catch (error) {
            callback(error);
        }
    }

    _flush(callback) {
        if (!this.header) {
            callback(new Error('corrupted part: missing header'));
            return;
        }
        if (this.frameLength !== null || this.queue.length > 0) {
            callback(new Error('corrupted part: truncated frame'));
            return;
        }
        callback();
    }

    _drain() {
        if (!this.header) {
            const header = this.queue.take(HEADER_LENGTH);
            if (!header) return;
            if (!header.subarray(0, 4).equals(MAGIC)) {
                throw new Error('corrupted part: bad magic (wrong key or not a tgbackup part)');
            }
            if (header.readUInt8(4) !== VERSION) {
                throw new Error(`unsupported part version ${header.readUInt8(4)}`);
            }
            this.header = header;
        }

        for (;;) {
            if (this.frameLength === null) {
                const lengthBytes = this.queue.peek(LENGTH_FIELD);
                if (!lengthBytes) return;
                const length = lengthBytes.readUInt32BE(0);
                if (length === 0) throw new Error('corrupted part: empty frame');
                if (length > this.maxFrameSize) throw new Error('corrupted part: frame too large');
                this.frameLength = length;
            }

            const frameSize = LENGTH_FIELD + NONCE_LENGTH + TAG_LENGTH + this.frameLength;
            const frame = this.queue.take(frameSize);
            if (!frame) return;

            const plaintext = this._decryptFrame(frame, this.frameLength);
            this.frameLength = null;
            this.push(plaintext);
        }
    }

    _decryptFrame(frame, length) {
        const nonce = frame.subarray(LENGTH_FIELD, LENGTH_FIELD + NONCE_LENGTH);
        const tag = frame.subarray(LENGTH_FIELD + NONCE_LENGTH, LENGTH_FIELD + NONCE_LENGTH + TAG_LENGTH);
        const ciphertext = frame.subarray(LENGTH_FIELD + NONCE_LENGTH + TAG_LENGTH);
        const decipher = crypto.createDecipheriv(ALGORITHM, this.key, nonce, { authTagLength: TAG_LENGTH });
        decipher.setAAD(this.header);
        decipher.setAuthTag(tag);
        const head = decipher.update(ciphertext);
        const tail = decipher.final();
        const plaintext = tail.length > 0 ? Buffer.concat([head, tail]) : head;
        if (plaintext.length !== length) throw new Error('corrupted part: frame length mismatch');
        return plaintext;
    }
}

function* bufferChunks(buffer, chunkSize = 1024 * 1024) {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
    }
}

/**
 * Encrypt `inputPath` to `outputPath` with every key, in order. Each key adds
 * a full authenticated-encryption layer (inner key first, outer key last).
 */
async function encryptFile(inputPath, outputPath, keys, options = {}) {
    const stages = keys.map((key) => new FrameEncryptor(key, options));
    await pipeline(fs.createReadStream(inputPath), ...stages, fs.createWriteStream(outputPath, { mode: 0o600 }));
}

/** Same as encryptFile but for an in-memory buffer. */
async function encryptBufferToFile(buffer, outputPath, keys, options = {}) {
    const stages = keys.map((key) => new FrameEncryptor(key, options));
    // objectMode:false keeps the reader's high-water mark in bytes (16 KiB)
    // instead of buffering 16 x 1 MiB chunk objects ahead of the encryptor.
    await pipeline(
        Readable.from(bufferChunks(buffer), { objectMode: false }),
        ...stages,
        fs.createWriteStream(outputPath, { mode: 0o600 }),
    );
}

/** Reverse of encryptFile: layers are removed in reverse key order. */
async function decryptFile(inputPath, outputPath, keys, options = {}) {
    const stages = keys.slice().reverse().map((key) => new FrameDecryptor(key, options));
    await pipeline(fs.createReadStream(inputPath), ...stages, fs.createWriteStream(outputPath, { mode: 0o600 }));
}

module.exports = {
    ALGORITHM,
    KEY_LENGTH,
    DEFAULT_FRAME_SIZE,
    FrameEncryptor,
    FrameDecryptor,
    encryptFile,
    encryptBufferToFile,
    decryptFile,
};
