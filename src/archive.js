'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const tar = require('tar');

const { UsageError } = require('./util');

function assertZstdSupport() {
    if (typeof zlib.createZstdCompress !== 'function' || typeof zlib.createZstdDecompress !== 'function') {
        throw new UsageError(
            `zstd is not available in Node ${process.version}; install Node >= 22.15.0 (built-in zstd support)`,
        );
    }
}

/**
 * tar the target with zstd compression. The archive contains the target's
 * basename as its root entry, so restoring reproduces the original layout
 * (e.g. /srv/data -> `<out>/data/...`).
 */
function createArchiveStream(targetPath, options = {}) {
    assertZstdSupport();
    const level = options.level ?? 10;
    const resolved = path.resolve(targetPath);
    const entry = path.basename(resolved);
    const cwd = path.dirname(resolved);

    if (!entry) throw new UsageError(`cannot archive ${resolved}`);

    const tarStream = tar.create(
        {
            cwd,
            portable: true,
            follow: Boolean(options.followSymlinks),
            // Keep the archive deterministic-ish and stream friendly.
            noMtime: false,
        },
        [entry],
    );

    const compressor = zlib.createZstdCompress({
        params: {
            [zlib.constants.ZSTD_c_compressionLevel]: level,
        },
    });

    return tarStream.pipe(compressor);
}

function createDecompressorStream() {
    assertZstdSupport();
    return zlib.createZstdDecompress();
}

function createExtractStream(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return tar.x({
        cwd: directory,
        portable: true,
        preservePaths: false,
    });
}

module.exports = {
    assertZstdSupport,
    createArchiveStream,
    createDecompressorStream,
    createExtractStream,
};
