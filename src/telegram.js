'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const { Api, TelegramClient, errors } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Logger } = require('telegram/extensions');
const { LogLevel } = require('telegram/extensions/Logger');
const { CustomFile } = require('telegram/client/uploads');
const qrcode = require('qrcode-terminal');

const { UsageError, ensureDir, warnIfLoosePermissions } = require('./util');
const fsp = require('node:fs/promises');
const { log, warn } = require('./log');

// Parallel chunk downloads (AyuGram-style): the document is cut into fixed
// 512 KiB chunks fetched with Api.upload.GetFile and written straight to
// disk at their file offset. 512 KiB satisfies the Telegram constraint that
// offsets *and* limits are multiples of 4096 while staying under the
// 0.75 MiB limit for large files at any size.
//
// Downloads run on `download_senders` *dedicated MTProto senders* (separate
// MTProto connections, each owning its TCP congestion window — the way
// desktop clients saturate a proxy) with `download_workers_per_sender`
// concurrent GetFile requests per sender. Total parallel chunks is the
// product of the two knobs.
const DOWNLOAD_CHUNK_SIZE = 512 * 1024;
const DEFAULT_DOWNLOAD_SENDERS = 4;
const MAX_DOWNLOAD_SENDERS = 8;
const DEFAULT_DOWNLOAD_WORKERS_PER_SENDER = 2;
const MAX_DOWNLOAD_WORKERS_PER_SENDER = 8;
/** Honor server-imposed FLOOD_WAIT waits up to this long, fail beyond it. */
const FLOOD_WAIT_CAP_SECONDS = 300;
/** Transient failures tolerated per chunk before aborting the part. */
const CHUNK_ATTEMPTS = 8;
/** Safety caps so server quirks cannot loop forever. */
const MAX_FLOOD_RETRIES = 20;
const MAX_DC_MIGRATIONS = 4;

function buildClientParams(config) {
    const params = {
        connectionRetries: 10,
        requestRetries: 5,
        downloadRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
        floodSleepThreshold: 120,
        // GramJS logs through console.log, which we only redirect to stderr.
        baseLogger: new Logger(LogLevel.ERROR),
    };

    if (config.proxy) {
        params.proxy = {
            ip: config.proxy.host,
            port: config.proxy.port,
            socksType: config.proxy.type === 'socks4' ? 4 : 5,
            username: config.proxy.username,
            password: config.proxy.password,
            timeout: config.proxy.timeout,
        };
    }

    return params;
}

function readSession(config) {
    if (config.sessionFile && fs.existsSync(config.sessionFile)) {
        const stored = fs.readFileSync(config.sessionFile, 'utf8').trim();
        if (stored) {
            const warning = warnIfLoosePermissions(config.sessionFile);
            if (warning) warn(warning.replace(/^warning:\s*/, ''));
            return stored;
        }
    }
    return config.session || '';
}

function saveSession(config, session) {
    ensureDir(path.dirname(config.sessionFile));
    fs.writeFileSync(config.sessionFile, `${session}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(config.sessionFile, 0o600);
    } catch {
        /* best effort on platforms without chmod */
    }
}

async function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await rl.question(question);
        return answer.trim();
    } finally {
        rl.close();
    }
}

/** Plain TCP reachability check, useful to diagnose a proxy before MTProto. */
function checkTcp(host, port, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const finish = (error) => {
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(
            () => finish(new Error(`timed out after ${timeoutMs} ms`)),
            timeoutMs,
        );
        socket.once('connect', () => finish());
        socket.once('error', (error) => finish(error));
    });
}

async function disconnectQuietly(client, timeoutMs = 5000) {
    if (!client) return;
    try {
        await Promise.race([client.disconnect().catch(() => {}), sleep(timeoutMs)]);
    } catch {
        /* ignore */
    }
}

function connectionHint(error, config) {
    const message = error && error.message ? error.message : String(error);
    if (config.proxy) {
        return (
            `cannot connect to Telegram through SOCKS proxy ${config.proxy.host}:${config.proxy.port}: ${message}\n` +
            'check that the proxy is reachable and allows traffic to Telegram data centers'
        );
    }
    return (
        `cannot connect to Telegram: ${message}\n` +
        'Telegram may be blocked on this network. Configure an outbound SOCKS proxy ' +
        '(config.yml "proxy", TGBACKUP_PROXY, or --proxy socks5://host:port)'
    );
}

async function loginWithQr(client, config) {
    log('QR login: open Telegram on a device where you are already logged in,');
    log('go to Settings -> Devices -> Link Desktop Device, then scan the code below.');
    await client.signInUserWithQrCode(
        { apiId: config.apiId, apiHash: config.apiHash },
        {
            qrCode: async ({ token, expires }) => {
                const url = `tg://login?token=${token.toString('base64url')}`;
                qrcode.generate(url, { small: true }, (rendered) => {
                    process.stderr.write(`${rendered}\n`);
                });
                const expiry = typeof expires === 'number' && expires > 1e12 ? ` (expires ${new Date(expires).toISOString()})` : '';
                process.stderr.write(`link: ${url}${expiry}\n`);
            },
            password: async () => prompt('Two-factor password (leave empty if none): '),
            onError: async (error) => {
                log(`QR login error: ${error.message}`);
                return false;
            },
        },
    );
}

/**
 * Connect (and, when allowed, log in) and return a ready client.
 * In non-interactive mode a missing/expired session is a hard error unless
 * `requireAuth` is false (used by the `check` command).
 */
async function connect(config, options = {}) {
    const session = readSession(config);
    const client = new TelegramClient(new StringSession(session), config.apiId, config.apiHash, buildClientParams(config));

    let connected = false;
    try {
        const timeoutMs = options.timeoutMs ?? config.connectTimeoutMs ?? 30000;
        const connecting = client.connect();
        // The race below may abandon this promise; keep Node from reporting it as unhandled.
        connecting.catch(() => {});

        let timer;
        try {
            await Promise.race([
                connecting,
                new Promise((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`connection timed out after ${Math.round(timeoutMs / 1000)}s`)),
                        timeoutMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        connected = true;

        if (!(await client.checkAuthorization())) {
            if (options.requireAuth === false) return client;

            const interactive = options.interactive && process.stdin.isTTY;
            if (!interactive) {
                throw new UsageError(
                    'not logged in to Telegram (session missing or expired); run "tgbackup login" from an interactive terminal',
                );
            }

            log('logging in to Telegram...');
            if (options.qr) {
                await loginWithQr(client, config);
            } else {
                log('requesting a login code (Telegram usually delivers it inside the app, not by SMS)');
                await client.signInUser(
                    { apiId: config.apiId, apiHash: config.apiHash },
                    {
                        forceSMS: Boolean(options.forceSms),
                        phoneNumber: async () => prompt('Phone number (international format, e.g. +15551234567): '),
                        password: async () => prompt('Two-factor password (leave empty if none): '),
                        phoneCode: async () =>
                            prompt(
                                'Login code from Telegram (or the SMS): ',
                            ),
                        onError: (error) => log(`login error: ${error.message}`),
                    },
                );
            }
        }

        const saved = client.session.save();
        if (saved) saveSession(config, saved);
        return client;
    } catch (error) {
        await disconnectQuietly(client);
        if (!connected) throw new Error(connectionHint(error, config));
        throw error;
    }
}

async function uploadDocument(client, options) {
    const { target, filePath, fileName, size, caption, workers = 8, onProgress } = options;

    const input = await client.uploadFile({
        file: new CustomFile(fileName, size, filePath),
        workers,
        // GramJS reports progress as a 0..1 fraction; convert it to percent so
        // consumers (the CLI progress bar) do not show a stuck "0%".
        onProgress: onProgress ? (fraction) => onProgress(Number(fraction) * 100) : undefined,
    });

    const message = await client.sendFile(target, {
        file: input,
        forceDocument: true,
        caption,
        parseMode: undefined,
    });

    if (!message || typeof message.id !== 'number') {
        throw new Error('Telegram did not return a message id');
    }
    return message;
}

function extractDocument(message, messageId) {
    const media = message && message.media;
    const doc = media && media.document;
    if (!doc || doc.className === 'documentEmpty' || doc.id === undefined || doc.id === null) {
        throw new Error(`message ${messageId} not found or has no document attached`);
    }
    return doc;
}

/**
 * Downloads a document with raw Api.upload.GetFile requests (instead of
 * GramJS' sequential downloadMedia): `senders` dedicated MTProto senders
 * (separate connections, each with its own TCP congestion window) each run
 * `workersPerSender` concurrent chunk workers; workers pull the next
 * 512 KiB offset from a shared queue and write chunks straight to disk at
 * their offsets via a file-handle pwrite, so the file never sits in memory
 * and out-of-order chunks are fine.
 */
async function downloadDocument(client, options) {
    const { target, messageId, outputPath, onProgress, stallTimeoutMs } = options;
    const sendersCount = Math.max(
        1,
        Math.min(MAX_DOWNLOAD_SENDERS, Number(options.senders) || DEFAULT_DOWNLOAD_SENDERS),
    );
    const perSender = Math.max(
        1,
        Math.min(
            MAX_DOWNLOAD_WORKERS_PER_SENDER,
            Number(options.workersPerSender) || DEFAULT_DOWNLOAD_WORKERS_PER_SENDER,
        ),
    );

    // A previous attempt may have disconnected the senders after a stall.
    if (client.disconnected) {
        try {
            await client.connect();
        } catch (error) {
            throw new Error(`reconnecting to Telegram failed: ${error.message}`);
        }
    }

    const messages = await client.getMessages(target, { ids: [messageId] });
    const message = Array.isArray(messages) ? messages[0] : messages;
    if (!message || !message.media) {
        throw new Error(`message ${messageId} not found or has no document attached`);
    }

    const doc = extractDocument(message, messageId);
    const size = Number(doc.size);
    if (!Number.isFinite(size) || size < 0) {
        throw new Error(`message ${messageId} has a document without a known size`);
    }
    const onLocalProgress = onProgress
        ? (received, total) => onProgress(Number(received), Number(total))
        : undefined;

    if (size === 0) {
        await fsp.writeFile(outputPath, Buffer.alloc(0), { mode: 0o600 });
        onLocalProgress?.(0, 0);
        return message;
    }

    const location = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference || Buffer.alloc(0),
        thumbSize: '', // the document itself, not a thumbnail
    });
    // Until the document's DC is known (very old media without dcId) all
    // slots alias the main client sender; a FileMigrateError moves the whole
    // pool to dedicated senders in the right data center.
    let poolDc = doc.dcId === undefined || doc.dcId === null ? undefined : Number(doc.dcId);

    // Out-of-order writes land straight on disk at their file offset; the
    // file is pre-truncated so the final size is already correct (sparse).
    const file = await fsp.open(outputPath, 'w', 0o600);
    const closed = { value: false };
    const closeFile = async () => {
        if (closed.value) return;
        closed.value = true;
        try {
            await file.close();
        } catch {
            /* best effort */
        }
    };

    let fatal = null;
    let cursor = 0; // shared offset queue; claiming is synchronous → atomic
    let completedBytes = 0;
    let lastActivity = Date.now();
    const watchdogFired = { value: false };

    const quietDisconnect = (sender) =>
        sender && typeof sender.disconnect === 'function'
            ? Promise.resolve(sender.disconnect()).catch(() => {})
            : Promise.resolve();

    // ---- sender pool ----
    // gramjs caches exactly one sender per DC (_borrowExportedSender), so a
    // multi-line pool is assembled here from the same internals and closed
    // manually — manually created senders have no release timer.
    let pool = [];
    let poolOwned = false; // false → every slot aliases the main client sender
    let poolBuiltDc = undefined;
    let poolBuilt = false;
    let building = null;

    async function openSender(dc) {
        const sender = client._createExportedSender(dc);
        try {
            // Exports the authorization for foreign DCs and connects through
            // the very same proxy the client uses.
            await client._connectSender(sender, dc);
        } catch (error) {
            await quietDisconnect(sender);
            throw error;
        }
        return sender;
    }

    async function buildPool(dc) {
        const fresh = [];
        let freshOwned = false;
        try {
            if (dc === undefined) {
                // Unknown DC: all slots share the client's main sender.
                const shared = await client.getSender(undefined);
                for (let i = 0; i < sendersCount; i += 1) fresh.push(shared);
            } else {
                freshOwned = true;
                // Sequential on purpose: gramjs' _connectSender mutates the
                // shared _initRequest while exporting auth, so parallel
                // inits could interleave with the main client's requests.
                for (let i = 0; i < sendersCount; i += 1) {
                    fresh.push(await openSender(dc));
                    lastActivity = Date.now(); // connecting counts as activity
                }
            }
        } catch (error) {
            if (freshOwned) await Promise.allSettled(fresh.map(quietDisconnect));
            throw error;
        }
        // Swap the pool first, then retire the old owned senders, so a
        // failed build never leaves the workers without a usable pool.
        const retired = poolOwned ? pool.slice() : [];
        pool = fresh;
        poolOwned = freshOwned;
        poolBuiltDc = dc;
        poolBuilt = true;
        await Promise.allSettled(retired.map(quietDisconnect));
        return pool;
    }

    async function currentPool() {
        for (;;) {
            if (building !== null) {
                await building; // build errors surface as transient failures
                continue; // re-check afterwards (the DC may have moved on)
            }
            if (poolBuilt && poolBuiltDc === poolDc) return pool;
            building = buildPool(poolDc).finally(() => {
                building = null;
            });
            await building;
        }
    }

    // A dead line is replaced per slot; perSender workers share a slot and
    // therefore wait on the same replacement promise instead of racing.
    const slotJobs = new Map();

    async function senderForSlot(slot) {
        const poolNow = await currentPool();
        const index = slot % poolNow.length;
        const sender = poolNow[index];
        if (sender && typeof sender.isConnected === 'function' && sender.isConnected()) return sender;
        if (slotJobs.has(index)) return slotJobs.get(index);
        const job = (async () => {
            if (poolOwned && poolDc !== undefined) {
                const fresh = await openSender(poolDc);
                if (poolNow === pool) {
                    const old = pool[index];
                    pool[index] = fresh;
                    await quietDisconnect(old);
                }
                return fresh;
            }
            // Aliased main sender: revive the client itself.
            if (client.disconnected) {
                try {
                    await client.connect();
                } catch {
                    /* the invoke below fails and retries */
                }
            }
            return poolNow[index];
        })().finally(() => slotJobs.delete(index));
        slotJobs.set(index, job);
        return job;
    }

    /**
     * Sleep while refreshing lastActivity so a server-ordered wait is not
     * mistaken for a stalled connection by the watchdog below.
     * @param {number} ms
     */
    async function sleepKeepingActivity(ms) {
        for (let done = 0; done < ms; done += 1000) {
            lastActivity = Date.now();
            await sleep(Math.min(1000, ms - done));
        }
    }

    async function fetchChunk(slot, offset, expected) {
        let floodRetries = 0;
        let migrations = 0;
        for (let attempt = 1; ; attempt += 1) {
            if (fatal) throw fatal;
            try {
                const sender = await senderForSlot(slot);
                const result = await client.invokeWithSender(
                    new Api.upload.GetFile({ location, offset, limit: DOWNLOAD_CHUNK_SIZE }),
                    sender,
                );
                if (result instanceof Api.upload.FileCdnRedirect) {
                    throw new Error('Telegram served the document from a CDN, which tgbackup cannot fetch');
                }
                const bytes = result.bytes;
                if (!bytes || bytes.length !== expected) {
                    // A short read before the end of the file is a broken
                    // response; retry the chunk instead of writing a hole.
                    throw new Error(
                        `server returned ${bytes ? bytes.length : 0} of ${expected} bytes at offset ${offset}`,
                    );
                }
                return bytes;
            } catch (error) {
                if (fatal) throw fatal;
                if (error instanceof errors.FileMigrateError) {
                    if (++migrations > MAX_DC_MIGRATIONS) {
                        throw new Error('the document keeps migrating between data centers');
                    }
                    poolDc = error.newDc; // the next chunk rebuilds the pool there
                    continue;
                }
                if (error instanceof errors.FloodWaitError) {
                    const seconds = Number(error.seconds) || 0;
                    if (seconds > FLOOD_WAIT_CAP_SECONDS) {
                        throw new Error(
                            `server throttled the download: FLOOD_WAIT ${seconds}s exceeds ` +
                                `tgbackup's ${FLOOD_WAIT_CAP_SECONDS}s cap; retry later`,
                        );
                    }
                    if (++floodRetries > MAX_FLOOD_RETRIES) {
                        throw new Error('the server keeps throttling the download (repeated FLOOD_WAIT)');
                    }
                    // Waits of up to 120 s are already slept by GramJS itself
                    // (floodSleepThreshold); longer waits are honored here.
                    if (seconds > 0) await sleepKeepingActivity(seconds * 1000);
                    continue;
                }
                if (attempt >= CHUNK_ATTEMPTS) throw error;
                await sleepKeepingActivity(Math.min(3000, 250 * attempt));
            }
        }
    }

    async function worker(slot) {
        try {
            for (;;) {
                if (fatal) return;
                const offset = cursor;
                if (offset >= size) return;
                cursor = offset + DOWNLOAD_CHUNK_SIZE;

                const expected = Math.min(DOWNLOAD_CHUNK_SIZE, size - offset);
                const bytes = await fetchChunk(slot, offset, expected);
                if (fatal) return;
                const written = await file.write(bytes, 0, bytes.length, offset);
                if (written.bytesWritten !== bytes.length) {
                    throw new Error(
                        `short write at offset ${offset} (${written.bytesWritten}/${bytes.length} bytes); is the disk full?`,
                    );
                }
                completedBytes += bytes.length;
                lastActivity = Date.now();
                onLocalProgress?.(completedBytes, size);
            }
        } catch (error) {
            if (!fatal) fatal = error; // stop the other workers
        }
    }

    // Watchdog: if not a single chunk completes within `stallTimeoutMs`
    // (frozen proxy / dead datacenter connection), kill the connections so
    // the caller can retry the whole part from scratch instead of hanging.
    let rejectWatchdog;
    const watchdog = new Promise((_resolve, reject) => {
        rejectWatchdog = (error) => {
            watchdogFired.value = true;
            if (!fatal) fatal = error;
            reject(error);
        };
    });
    watchdog.catch(() => {}); // after the race resolves, rejections are moot

    const checkIntervalMs = Math.min(1000, Math.max(50, Math.round(stallTimeoutMs / 4)));
    const timer =
        stallTimeoutMs > 0
            ? setInterval(() => {
                  if (Date.now() - lastActivity >= stallTimeoutMs) {
                      rejectWatchdog(
                          new Error(
                              `download stalled: no data for ${Math.round(stallTimeoutMs / 1000)}s ` +
                                  '(proxy or datacenter connection frozen)',
                          ),
                      );
                  }
              }, checkIntervalMs)
            : null;

    try {
        await file.truncate(size);

        const workerPool = Promise.all(
            Array.from(
                { length: sendersCount * perSender },
                (_value, index) => worker(index % sendersCount),
            ),
        );
        workerPool.catch(() => {}); // worker errors land in `fatal`, never unhandled

        try {
            await Promise.race([workerPool, watchdog]);
        } catch (error) {
            if (!watchdogFired.value) throw error;
            // Watchdog fired: kill every socket involved (the main client
            // plus every dedicated line the pool owns), then fail so the
            // caller retries the whole part from scratch.
            const kills = [client.disconnect()];
            if (poolOwned) for (const sender of pool) kills.push(quietDisconnect(sender));
            for (const kill of kills) {
                try {
                    await Promise.race([Promise.resolve(kill).catch(() => {}), sleep(5000)]);
                } catch {
                    /* best effort */
                }
            }
            throw fatal ?? error;
        }

        if (fatal) throw fatal;

        const stat = await file.stat();
        if (stat.size !== size) {
            throw new Error(`downloaded file is ${stat.size} bytes, Telegram reported ${size}`);
        }
        onLocalProgress?.(completedBytes, size);
        return message;
    } finally {
        if (timer) clearInterval(timer);
        const pendingBuild = building;
        if (pendingBuild) {
            await Promise.race([pendingBuild.catch(() => {}), sleep(10000)]);
        }
        if (poolOwned) await Promise.allSettled(pool.map(quietDisconnect));
        await closeFile();
        if (watchdogFired.value) {
            try {
                await fsp.rm(outputPath, { force: true });
            } catch {
                /* best effort */
            }
        }
    }
}

async function closeClient(client) {
    await disconnectQuietly(client);
}

module.exports = {
    buildClientParams,
    checkTcp,
    connect,
    uploadDocument,
    downloadDocument,
    closeClient,
    DOWNLOAD_CHUNK_SIZE,
    DEFAULT_DOWNLOAD_SENDERS,
    MAX_DOWNLOAD_SENDERS,
    DEFAULT_DOWNLOAD_WORKERS_PER_SENDER,
    MAX_DOWNLOAD_WORKERS_PER_SENDER,
};
