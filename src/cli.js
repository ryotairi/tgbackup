'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runBackup } = require('./backup');
const cleanup = require('./cleanup');
const { loadConfig, normalizeProxy, normalizeUploadDelay, normalizeUploadWorkers } = require('./config');
const { runInit } = require('./init');
const { log, protectStdout } = require('./log');
const { runRestore } = require('./restore');
const { checkTcp, closeClient, connect } = require('./telegram');
const { decodeToken } = require('./token');
const { UsageError, formatBytes, parseSize } = require('./util');

const pkg = require('../package.json');

const BOOLEAN_OPTIONS = new Set(['help', 'version', 'force', 'keepTmp', 'json', 'nonInteractive', 'qr', 'forceSms', 'stage']);

const USAGE = `tgbackup ${pkg.version} - encrypted, chunked backups in Telegram

Usage:
  tgbackup init [--dir <dir>] [--force]
  tgbackup login [--qr | --force-sms] [--proxy <socks-url>]
  tgbackup check [--proxy <socks-url>]
  tgbackup backup <path> [options]
  tgbackup restore <token|-> [options]
  tgbackup info <token|-> [--json]
  tgbackup help

Global options:
  --config <path>       config file (default: ./config.yml or ~/.config/tgbackup/config.yml)
  --proxy <socks-url>   override the configured SOCKS proxy, or "none" for a direct connection
  -h, --help            show this help
  --version             show version

login options:
  --qr                  link via QR code (Telegram -> Settings -> Devices -> Link Desktop Device)
  --force-sms           request the code by SMS instead of inside the Telegram app

backup options:
  --name <name>         backup name (default: backup-<timestamp>)
  --part-size <size>    bytes or a suffix such as 128M / 1G (default from config)
  --zstd-level <1-22>   zstd compression level (default from config)
  --delay <min,max>     random delay in seconds between part uploads
  --workers <1-16>      parallel upload workers per part (default 8)
  --no-stage            pack and upload in one pass (no upfront part count)
  --token-out <file>    additionally write the token to a file (mode 0600)
  --keep-tmp            keep temporary part files
  --non-interactive     never prompt for a Telegram login

restore options:
  --out <dir>           restore destination (default: ./restore-<name>)
  --workers <1-16>      parallel download workers per part (default from upload_workers)
  --token-file <file>   read the token from a file instead of the argument
  --keep-tmp            keep temporary part files
  --non-interactive     never prompt for a Telegram login

info options:
  --json                print machine-readable JSON

Security model:
  Every part is encrypted with a random per-backup key (AES-256-GCM) and then
  again with your single master key. The printed base64url token contains the
  Telegram message ids and the per-backup key; the master key stays local.
  Both the token and master key are required to restore.
`;

function camelCase(name) {
    return name.replace(/-([a-z0-9])/g, (_match, letter) => letter.toUpperCase());
}

function parseArgv(argv) {
    const options = {};
    const positionals = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--') {
            positionals.push(...argv.slice(index + 1));
            break;
        }
        if (arg === '-h') {
            options.help = true;
            continue;
        }
        if (!arg.startsWith('--')) {
            positionals.push(arg);
            continue;
        }

        let body = arg.slice(2);
        let value;
        const equals = body.indexOf('=');
        if (equals !== -1) {
            value = body.slice(equals + 1);
            body = body.slice(0, equals);
        }

        if (body.startsWith('no-') && value === undefined) {
            options[camelCase(body.slice(3))] = false;
            continue;
        }

        const key = camelCase(body);
        if (BOOLEAN_OPTIONS.has(key)) {
            options[key] = value === undefined ? true : value !== 'false';
            continue;
        }
        if (value !== undefined) {
            options[key] = value;
            continue;
        }

        const next = argv[index + 1];
        if (next === undefined) {
            options[key] = true;
        } else {
            options[key] = next;
            index += 1;
        }
    }

    return { options, positionals };
}

function requireValue(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new UsageError(`${label} requires a value`);
    }
    return value;
}

function parseInteger(value, label, min, max) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new UsageError(`${label} must be an integer between ${min} and ${max}`);
    }
    return number;
}

function parseDelay(value) {
    const parts = String(value).split(',').map((part) => part.trim());
    if (parts.length > 2) throw new UsageError('--delay expects <min,max> in seconds');
    const min = Number(parts[0]);
    const max = parts.length === 2 ? Number(parts[1]) : min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
        throw new UsageError('--delay expects non-negative numbers in seconds');
    }
    if (min > max) throw new UsageError('--delay minimum cannot exceed maximum');
    return { min, max };
}

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
}

async function readToken(options, positionals) {
    if (options.tokenFile !== undefined) {
        const tokenFile = requireValue(options.tokenFile, '--token-file');
        return fs.readFileSync(path.resolve(tokenFile), 'utf8').trim();
    }
    const argument = positionals[0];
    if (argument === undefined) {
        throw new UsageError('missing token (pass it as an argument, with --token-file, or "-" to read stdin)');
    }
    if (argument === '-') return readStdin();
    return argument.trim();
}

function resolveConfig(options) {
    const config = loadConfig({ configPath: options.config });
    if (options.proxy !== undefined) {
        const value = requireValue(options.proxy, '--proxy');
        config.proxy = /^(none|off|direct)$/i.test(value) ? null : normalizeProxy(value);
    }
    return config;
}

async function commandLogin(options) {
    const config = resolveConfig(options);
    const client = await connect(config, {
        interactive: true,
        qr: Boolean(options.qr),
        forceSms: Boolean(options.forceSms),
    });
    try {
        const me = await client.getMe();
        const who = me && (me.username ? `@${me.username}` : me.firstName || me.id);
        log(`logged in${who ? ` as ${who}` : ''}; session saved to ${config.sessionFile}`);
    } finally {
        await closeClient(client);
    }
}

async function commandCheck(options) {
    const config = resolveConfig(options);

    if (config.proxy) {
        const label = `SOCKS${config.proxy.type === 'socks4' ? '4' : '5'} proxy ${config.proxy.host}:${config.proxy.port}`;
        log(`checking ${label}...`);
        try {
            await checkTcp(config.proxy.host, config.proxy.port);
        } catch (error) {
            throw new Error(`cannot reach ${label}: ${error.message}`);
        }
        log(`${label} is reachable`);
    } else {
        log('no proxy configured; connecting directly');
    }

    log('connecting to Telegram...');
    const client = await connect(config, { interactive: false, requireAuth: false, timeoutMs: 15000 });
    try {
        const authorized = await client.checkAuthorization();
        log('Telegram connection established');
        if (authorized) {
            const me = await client.getMe();
            const who = me && (me.username ? `@${me.username}` : me.firstName || me.id);
            log(`session is valid${who ? ` for ${who}` : ''}`);
        } else {
            log('session is missing or expired; run "tgbackup login" using the same proxy');
        }
    } finally {
        await closeClient(client);
    }
}

async function commandBackup(options, positionals) {
    const target = positionals[0];
    if (!target) throw new UsageError('backup: missing path to back up');
    if (positionals.length > 1) throw new UsageError('backup: too many positional arguments');

    const config = resolveConfig(options);
    const token = await runBackup(config, {
        path: target,
        name: options.name === undefined ? undefined : requireValue(options.name, '--name'),
        partSize: options.partSize === undefined ? undefined : parseSize(options.partSize, '--part-size'),
        zstdLevel:
            options.zstdLevel === undefined ? undefined : parseInteger(options.zstdLevel, '--zstd-level', 1, 22),
        uploadDelay: options.delay === undefined ? undefined : normalizeUploadDelay(parseDelay(options.delay)),
        uploadWorkers:
            options.workers === undefined ? undefined : normalizeUploadWorkers(options.workers, '--workers'),
        stage: options.stage === undefined ? undefined : Boolean(options.stage),
        tokenOut: options.tokenOut === undefined ? undefined : requireValue(options.tokenOut, '--token-out'),
        keepTmp: Boolean(options.keepTmp),
        interactive: !options.nonInteractive,
    });

    // The token is the command's only stdout output so it can be captured in a pipe.
    process.stdout.write(`${token}\n`);
}

async function commandRestore(options, positionals) {
    const token = await readToken(options, positionals);
    const config = resolveConfig(options);
    await runRestore(config, {
        token,
        out: options.out === undefined ? undefined : requireValue(options.out, '--out'),
        workers:
            options.workers === undefined ? undefined : normalizeUploadWorkers(options.workers, '--workers'),
        keepTmp: Boolean(options.keepTmp),
        interactive: !options.nonInteractive,
    });
}

async function commandInfo(options, positionals) {
    const token = decodeToken(await readToken(options, positionals));
    const totalEncrypted = token.parts.reduce((sum, part) => sum + part.size, 0);

    if (options.json) {
        const payload = {
            name: token.name,
            createdAt: token.createdAt,
            chat: token.chat,
            root: token.root,
            parts: token.parts,
            totalEncrypted,
        };
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }

    const lines = [
        `name: ${token.name}`,
        `created: ${token.createdAt || 'unknown'}`,
        `parts: ${token.parts.length}`,
        `encrypted size: ${formatBytes(totalEncrypted)}`,
    ];
    if (token.chat) lines.push(`chat: ${token.chat} (parts live here; restore uses this)`);
    if (token.root) lines.push(`archive root: ${token.root}`);
    token.parts.forEach((part, index) => {
        lines.push(`  part ${index + 1}: message ${part.id}, ${formatBytes(part.size)}`);
    });
    process.stdout.write(`${lines.join('\n')}\n`);
}

async function flushStream(stream) {
    if (!stream.writableLength) return;
    await new Promise((resolve) => stream.write('', () => resolve()));
}

async function exitGracefully() {
    // GramJS reconnect loops may keep sockets/timers alive after a failed
    // connect; make sure the CLI exits once all output is flushed.
    await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    process.exit(process.exitCode ?? 0);
}

async function main(argv = process.argv.slice(2)) {
    const restoreStdout = protectStdout();
    cleanup.install();

    try {
        const { options, positionals } = parseArgv(argv);

        if (options.config !== undefined) {
            options.config = requireValue(options.config, '--config');
        }

        if (options.version) {
            process.stdout.write(`${pkg.version}\n`);
            return;
        }
        if (options.help || positionals.length === 0) {
            process.stdout.write(USAGE);
            return;
        }

        const command = positionals.shift();
        switch (command) {
            case 'init':
                runInit({
                    dir: options.dir === undefined ? undefined : requireValue(options.dir, '--dir'),
                    force: Boolean(options.force),
                });
                return;
            case 'login':
                await commandLogin(options);
                return;
            case 'check':
                await commandCheck(options);
                return;
            case 'backup':
                await commandBackup(options, positionals);
                return;
            case 'restore':
                await commandRestore(options, positionals);
                return;
            case 'info':
                await commandInfo(options, positionals);
                return;
            case 'help':
                process.stdout.write(USAGE);
                return;
            default:
                throw new UsageError(`unknown command "${command}" (run "tgbackup help")`);
        }
    } catch (error) {
        if (error instanceof UsageError) {
            log(`error: ${error.message}`);
            process.exitCode = error.exitCode || 2;
        } else {
            log(`error: ${error.message}`);
            if (process.env.TGBACKUP_DEBUG) log(error.stack);
            process.exitCode = 1;
        }
    } finally {
        restoreStdout();
        await exitGracefully();
    }
}

module.exports = {
    main,
    parseArgv,
    USAGE,
};
