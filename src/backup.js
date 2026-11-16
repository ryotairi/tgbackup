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

        let partBuffer = null;
        let buffered = 0;
        let nextIndex = 0;

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
                                caption: `${config.prefix} ${name} [${index + 1}]`,
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

        const archive = createArchiveStream(targetPath, { level: zstdLevel });

        for await (const chunk of archive) {
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
