'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createArchiveStream } = require('./archive');
const cleanup = require('./cleanup');
const { DEFAULT_UPLOAD_WORKERS, PART_LIMIT_PREMIUM, PART_LIMIT_STANDARD } = require('./config');
const { encryptBufferToFile } = require('./crypto');
const { loadMasterKey } = require('./keys');
const { createPercentProgress, log, warn } = require('./log');
const { pipeline } = require('node:stream/promises');
const { closeClient, connect, uploadDocument } = require('./telegram');
const { encodeToken } = require('./token');
const {
    UsageError,
    ensureDir,
    formatBytes,
    randomSleep,
    removeQuietly,
    slugify,
    timestampName,
    withRetry,
} = require('./util');

/** Approximate payload size of a file or directory tree (lstat-based walk). */
function measureTarget(targetPath) {
    const stat = fs.lstatSync(targetPath);
    if (stat.isFile()) return stat.size;

    let total = 0;
    const stack = [targetPath];
    while (stack.length > 0) {
        const directory = stack.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            try {
                const entryStat = fs.lstatSync(full);
                if (entryStat.isDirectory()) stack.push(full);
                else if (entryStat.isFile()) total += entryStat.size;
                // Symlinks and specials are skipped: tar stores them, but their
                // payload in the archive is small relative to a size estimate.
            } catch {
                /* vanished during the walk */
            }
        }
    }
    return total;
}

async function runBackup(config, options) {
    const targetPath = path.resolve(options.path);
    if (!fs.existsSync(targetPath)) {
        throw new UsageError(`nothing to back up at ${targetPath}`);
    }

    const name = options.name ? String(options.name) : timestampName('backup');
    const root = path.basename(targetPath);
    const partSize = options.partSize ?? config.partSize;
    const zstdLevel = options.zstdLevel ?? config.zstdLevel;
    const uploadWorkers = options.uploadWorkers ?? config.uploadWorkers ?? DEFAULT_UPLOAD_WORKERS;
    const uploadDelay = options.uploadDelay ?? config.uploadDelay;

    const partLimit = config.premium ? PART_LIMIT_PREMIUM : PART_LIMIT_STANDARD;
    if (!Number.isInteger(partSize) || partSize < 64 * 1024 || partSize > partLimit) {
        throw new UsageError(
            `part size must be an integer between 65536 and ${partLimit} bytes ` +
                `(${config.premium ? 'Premium' : 'standard'} account)`,
        );
    }

    const masterKey = loadMasterKey(config);
    // Fresh random key for this backup only. It is published in the token, the
    // master key wraps it (both layers are required to decrypt the parts).
    const backupKey = crypto.randomBytes(32);

    ensureDir(config.tmpDir);
    const tmpDir = fs.mkdtempSync(path.join(config.tmpDir, 'run-'));
    try {
        fs.chmodSync(tmpDir, 0o700);
    } catch {
        /* best effort */
    }
    cleanup.add(tmpDir);

    const parts = [];
    let archiveBytes = 0;
    let encryptedBytes = 0;
    let client;

    log(`backing up ${targetPath} as "${name}"`);
    log(`zstd level ${zstdLevel}, ${formatBytes(partSize)} per part, ${uploadWorkers} upload worker(s)`);
    if (config.proxy) log(`using SOCKS${config.proxy.type === 'socks4' ? '4' : '5'} proxy ${config.proxy.host}:${config.proxy.port}`);

    try {
        client = await connect(config, { interactive: options.interactive });

        const stage = options.stage ?? config.stageArchive ?? true;
        let partBuffer = null;
        let buffered = 0;
        let nextIndex = 0;
        let partCount; // unknown until the archive is known (staging) or done

        const uploadPart = async (length) => {
            const index = nextIndex;
            nextIndex += 1;

            const encryptedPath = path.join(tmpDir, `part-${String(index).padStart(5, '0')}.tgbk`);
            try {
                await encryptBufferToFile(partBuffer.subarray(0, length), encryptedPath, [backupKey, masterKey]);
                const size = fs.statSync(encryptedPath).size;
                encryptedBytes += size;

                if (index > 0 && uploadDelay.maxMs > 0) {
                    const waited = await randomSleep(uploadDelay.minMs, uploadDelay.maxMs);
                    if (waited > 0) log(`waiting ${(waited / 1000).toFixed(1)}s before next part`);
                }

                log(`uploading part ${index + 1} (${formatBytes(length)} archive -> ${formatBytes(size)} encrypted)`);
                let progress = null;
                try {
                    const message = await withRetry(
                        () => {
                            progress = createPercentProgress(`part ${index + 1}`);
                            return uploadDocument(client, {
                                target: config.target,
                                filePath: encryptedPath,
                                fileName: `${slugify(name)}.part${String(index).padStart(5, '0')}.tgbk`,
                                size,
                                caption: `${config.prefix} ${name} [${index + 1}${partCount === undefined ? '' : `/${partCount}`}]`,
                                workers: uploadWorkers,
                                onProgress: (percent) => progress.update(percent),
                            });
                        },
                        {
                            attempts: 4,
                            baseDelayMs: 3000,
                            onRetry: (error, attempt, delay) => {
                                if (progress) progress.finish();
                                log(
                                    `part ${index + 1} upload failed (${error.message}); ` +
                                        `retry ${attempt} in ${Math.round(delay / 1000)}s`,
                                );
                            },
                        },
                    );
                    if (progress) progress.finish();
                    parts.push({ id: message.id, size });
                    log(`part ${index + 1} -> message ${message.id}`);
                } finally {
                    if (progress) progress.finish();
                }
            } finally {
                fs.rmSync(encryptedPath, { force: true });
            }
        };

        if (stage) {
            // Pack first, upload second. Staging costs `archive size` of disk
            // in tmp_dir but gives the exact part count before any network
            // activity and makes per-part retries cheap.
            const archivePath = path.join(tmpDir, 'archive.tar.zst');
            log('packing the archive first so the exact part count is known (skip with --no-stage)');
            try {
                await pipeline(createArchiveStream(targetPath, { level: zstdLevel }), fs.createWriteStream(archivePath, { mode: 0o600 }));
            } catch (error) {
                if (error && error.code === 'ENOSPC') {
                    throw new Error(
                        `not enough disk space to stage the archive in ${tmpDir}; ` +
                            'free space or run with --no-stage to pack and upload in one pass',
                    );
                }
                throw error;
            }

            archiveBytes = fs.statSync(archivePath).size;
            if (!partBuffer) partBuffer = Buffer.allocUnsafe(partSize);
            partCount = Math.max(1, Math.ceil(archiveBytes / partSize));
            log(
                `archive: ${formatBytes(archiveBytes)} -> ${partCount} part(s), ` +
                    `${formatBytes(partSize)} each (the last one may be smaller)`,
            );

            const reader = fs.createReadStream(archivePath, { highWaterMark: 1024 * 1024 });
            try {
                for await (const chunk of reader) {
                    let offset = 0;
                    while (offset < chunk.length) {
                        const take = Math.min(partSize - buffered, chunk.length - offset);
                        chunk.copy(partBuffer, buffered, offset, offset + take);
                        buffered += take;
                        offset += take;

                        if (buffered === partSize) {
                            await uploadPart(buffered);
                            buffered = 0;
                        }
                    }
                }
            } finally {
                reader.destroy();
            }
            if (!options.keepTmp) fs.rmSync(archivePath, { force: true });
        } else {
            let sourceSize;
            try {
                sourceSize = measureTarget(targetPath);
            } catch {
                sourceSize = 0;
            }
            log(
                'packing and uploading in one pass (--no-stage); rough estimate: ' +
                    `${formatBytes(sourceSize)} -> up to ${Math.max(1, Math.ceil(sourceSize / partSize))} part(s)`,
            );

            for await (const chunk of createArchiveStream(targetPath, { level: zstdLevel })) {
                archiveBytes += chunk.length;
                if (!partBuffer) partBuffer = Buffer.allocUnsafe(partSize);

                let offset = 0;
                while (offset < chunk.length) {
                    const take = Math.min(partSize - buffered, chunk.length - offset);
                    chunk.copy(partBuffer, buffered, offset, offset + take);
                    buffered += take;
                    offset += take;

                    if (buffered === partSize) {
                        await uploadPart(buffered);
                        buffered = 0;
                    }
                }
            }
        }

        if (buffered > 0) {
            await uploadPart(buffered);
            buffered = 0;
        }

        if (parts.length === 0) throw new Error('archive is empty; nothing was uploaded');
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

    const token = encodeToken({
        name,
        createdAt: new Date().toISOString(),
        root,
        key: backupKey,
        parts,
    });

    if (options.tokenOut) {
        const tokenPath = path.resolve(options.tokenOut);
        ensureDir(path.dirname(tokenPath));
        fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
        log(`token written to ${tokenPath} (store it securely, it is the only copy of this backup's key)`);
    }

    log(
        `backup complete: ${parts.length} part(s), ${formatBytes(archiveBytes)} compressed, ` +
            `${formatBytes(encryptedBytes)} uploaded`,
    );

    return token;
}

module.exports = {
    runBackup,
};
