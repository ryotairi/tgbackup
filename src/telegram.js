'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline/promises');
const { setTimeout: sleep } = require('node:timers/promises');

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Logger } = require('telegram/extensions');
const { LogLevel } = require('telegram/extensions/Logger');
const { CustomFile } = require('telegram/client/uploads');
const qrcode = require('qrcode-terminal');

const { UsageError, ensureDir, warnIfLoosePermissions } = require('./util');
const { log, warn } = require('./log');

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
        onProgress: onProgress ? (percent) => onProgress(percent) : undefined,
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

async function downloadDocument(client, options) {
    const { target, messageId, outputPath, onProgress } = options;

    const messages = await client.getMessages(target, { ids: [messageId] });
    const message = Array.isArray(messages) ? messages[0] : messages;
    if (!message || !message.media) {
        throw new Error(`message ${messageId} not found or has no document attached`);
    }

    await client.downloadMedia(message, {
        outputFile: outputPath,
        progressCallback: onProgress ? (received, total) => onProgress(received, total) : undefined,
    });

    return message;
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
};
