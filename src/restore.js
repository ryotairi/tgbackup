'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { createDecompressorStream, createExtractStream } = require('./archive');
const cleanup = require('./cleanup');
const { decryptFile } = require('./crypto');
const { loadMasterKey } = require('./keys');
const { createProgress, log, warn } = require('./log');
const { closeClient, connect, downloadDocument } = require('./telegram');
const { decodeToken } = require('./token');
const {
    ensureDir,
    formatBytes,
    removeQuietly,
    slugify,
    withRetry,
} = require('./util');

async function runRestore(config, options) {
    const token = decodeToken(options.token);
    const masterKey = loadMasterKey(config);

    const destination = path.resolve(options.out || `restore-${slugify(token.name)}`);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

    ensureDir(config.tmpDir);
    const tmpDir = fs.mkdtempSync(path.join(config.tmpDir, 'run-'));
    try {
        fs.chmodSync(tmpDir, 0o700);
    } catch {
        /* best effort */
    }
    cleanup.add(tmpDir);

    log(`restoring backup "${token.name}" (${token.parts.length} part(s)) into ${destination}`);
    if (token.createdAt) log(`created at ${token.createdAt}`);
    if (config.proxy) log(`using SOCKS${config.proxy.type === 'socks4' ? '4' : '5'} proxy ${config.proxy.host}:${config.proxy.port}`);

    let client;
    try {
        client = await connect(config, { interactive: options.interactive });

        async function* decryptedParts() {
            for (let index = 0; index < token.parts.length; index += 1) {
                const part = token.parts[index];
                const label = `part ${index + 1}/${token.parts.length}`;
                const encryptedPath = path.join(tmpDir, `part-${String(index).padStart(5, '0')}.enc`);
                const plainPath = path.join(tmpDir, `part-${String(index).padStart(5, '0')}.raw`);

                log(`downloading ${label} (message ${part.id}, ${formatBytes(part.size)})`);
                let progress = null;
                try {
                    await withRetry(
                        () => {
                            progress = createProgress(`downloading ${label}`);
                            return downloadDocument(client, {
                                target: config.target,
                                messageId: part.id,
                                outputPath: encryptedPath,
                                onProgress: (received, total) =>
                                    progress.update(received, total || part.size),
                            });
                        },
                        {
                            attempts: 4,
                            baseDelayMs: 3000,
                            onRetry: (error, attempt, delay) => {
                                if (progress) progress.finish();
                                log(
                                    `${label} download failed (${error.message}); ` +
                                        `retry ${attempt} in ${Math.round(delay / 1000)}s`,
                                );
                            },
                        },
                    );
                } finally {
                    if (progress) progress.finish();
                }

                const actualSize = fs.statSync(encryptedPath).size;
                if (part.size > 0 && actualSize !== part.size) {
                    throw new Error(`${label} is ${actualSize} bytes, token says ${part.size}`);
                }

                log(`decrypting ${label}`);
                try {
                    await decryptFile(encryptedPath, plainPath, [token.key, masterKey]);
                } catch (error) {
                    throw new Error(`cannot decrypt ${label}: ${error.message} (wrong master key or corrupted part)`);
                } finally {
                    fs.rmSync(encryptedPath, { force: true });
                }

                const stream = fs.createReadStream(plainPath);
                try {
                    for await (const chunk of stream) yield chunk;
                } finally {
                    stream.destroy();
                    fs.rmSync(plainPath, { force: true });
                }
            }
        }

        await pipeline(
            Readable.from(decryptedParts(), { objectMode: false }),
            createDecompressorStream(),
            createExtractStream(destination),
        );
    } finally {
        if (client) await closeClient(client);
        if (options.keepTmp) {
            cleanup.remove(tmpDir);
            warn(`keeping temporary files in ${tmpDir}`);
        } else {
            cleanup.remove(tmpDir);
            removeQuietly(tmpDir);
        }
    }

    log(`restore complete: ${destination}`);
    return destination;
}

module.exports = {
    runRestore,
};
