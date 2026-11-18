'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { createDecompressorStream, createExtractStream } = require('./archive');
const cleanup = require('./cleanup');
const { DEFAULT_DOWNLOAD_STALL_SECONDS } = require('./config');
const { decryptFile } = require('./crypto');
const { loadMasterKey } = require('./keys');
const { createProgress, log, warn } = require('./log');
const { closeClient, connect, downloadDocument, DOWNLOAD_CHUNK_SIZE } = require('./telegram');
const { decodeToken } = require('./token');
const {
    ensureDir,
    formatBytes,
    formatDuration,
    removeQuietly,
    slugify,
    withRetry,
} = require('./util');

async function runRestore(config, options) {
    const token = decodeToken(options.token);
    const masterKey = loadMasterKey(config);

    // Backup/restore chat policy: the chat recorded in the token decides where
    // parts are downloaded from; config.target is only what `backup` uses.
    const chat = token.chat || config.target;
    if (!token.chat) {
        log('token has no chat id (old token format); using the chat from config');
    } else if (config.target && token.chat !== config.target) {
        warn(
            `token was created in chat ${token.chat}, but the config targets ${config.target}; ` +
                `restoring from ${token.chat}`,
        );
    }

    const totalParts = token.parts.length;
    const totalBytes = token.parts.reduce((sum, part) => sum + part.size, 0);
    const stallTimeoutMs =
        Number.isFinite(config.downloadStallMs) && config.downloadStallMs >= 0
            ? config.downloadStallMs
            : DEFAULT_DOWNLOAD_STALL_SECONDS * 1000;
    // The same tunable drives parallel uploads and parallel downloads; a
    // `--workers` flag on restore overrides the config value.
    const downloadWorkers = Number.isInteger(options.workers) && options.workers >= 1
        ? options.workers
        : config.uploadWorkers;

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

    log(
        `restoring backup "${token.name}" (${totalParts} part(s), ${formatBytes(totalBytes)}) into ${destination}`,
    );
    log(
        `download watchdog: retry a part when no data arrives for ${formatDuration(stallTimeoutMs)}` +
            (stallTimeoutMs === 0 ? ' (disabled)' : ''),
    );
    log(
        `download plan: ${downloadWorkers} parallel workers, ${formatBytes(DOWNLOAD_CHUNK_SIZE)} chunks per part`,
    );
    if (token.createdAt) log(`created at ${token.createdAt}`);
    if (config.proxy) log(`using SOCKS${config.proxy.type === 'socks4' ? '4' : '5'} proxy ${config.proxy.host}:${config.proxy.port}`);

    let client;
    try {
        client = await connect(config, { interactive: options.interactive });

        async function* decryptedParts() {
            const started = Date.now();
            let processedParts = 0;
            let processedBytes = 0;
            const progressLine = () => {
                const percent = totalBytes > 0 ? Math.round((processedBytes / totalBytes) * 100) : 100;
                log(
                    `progress: ${processedParts}/${totalParts} part(s) processed, ` +
                        `${formatBytes(processedBytes)}/${formatBytes(totalBytes)} (${percent}%), ` +
                        `elapsed ${formatDuration(Date.now() - started)}`,
                );
            };

            for (let index = 0; index < token.parts.length; index += 1) {
                const part = token.parts[index];
                const label = `part ${index + 1}/${totalParts}`;
                const encryptedPath = path.join(tmpDir, `part-${String(index).padStart(5, '0')}.enc`);
                const plainPath = path.join(tmpDir, `part-${String(index).padStart(5, '0')}.raw`);

                log(`downloading ${label} (message ${part.id}, ${formatBytes(part.size)})`);
                let progress = null;
                try {
                    await withRetry(
                        () => {
                            progress = createProgress(label);
                            return downloadDocument(client, {
                                target: chat,
                                messageId: part.id,
                                outputPath: encryptedPath,
                                stallTimeoutMs,
                                workers: downloadWorkers,
                                onProgress: (received, total) =>
                                    progress.update(received, total || part.size),
                            });
                        },
                        {
                            attempts: 5,
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
                    log(`${label}: download complete (${formatBytes(part.size)})`);
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
                processedParts += 1;
                processedBytes += part.size;
            }

            progressLine();
            log(
                `all ${totalParts} part(s) extracted in ${formatDuration(Date.now() - started)}; ` +
                    'finishing up',
            );
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
