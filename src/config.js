'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const { UsageError } = require('./util');

const PART_LIMIT_STANDARD = 2 ** 31 - 1; // Telegram: 2 GiB per document
const PART_LIMIT_PREMIUM = 4 * 1024 ** 3 - 1; // Telegram Premium: 4 GiB
const MIN_PART_SIZE = 64 * 1024;
const DEFAULT_PART_SIZE = 256 * 1024 * 1024;
const DEFAULT_ZSTD_LEVEL = 10;
const DEFAULT_UPLOAD_WORKERS = 8;
const MAX_UPLOAD_WORKERS = 16;
/** Kill and retry a download that stops receiving data for this long (seconds). */
const DEFAULT_DOWNLOAD_STALL_SECONDS = 300;

const CONFIG_FILENAMES = ['config.yml', 'config.yaml', 'tgbackup.yml', 'tgbackup.yaml'];

function envValue(name) {
    const value = process.env[name];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function resolveConfigPath(explicitPath) {
    const requested = explicitPath || envValue('TGBACKUP_CONFIG');
    if (requested) {
        const resolved = path.resolve(requested);
        if (!fs.existsSync(resolved)) {
            throw new UsageError(`config file not found: ${resolved}`);
        }
        return resolved;
    }

    const candidates = [
        ...CONFIG_FILENAMES.map((name) => path.resolve(process.cwd(), name)),
        path.join(os.homedir(), '.config', 'tgbackup', 'config.yml'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    throw new UsageError(
        `no config file found (looked for ${CONFIG_FILENAMES.join(', ')} in ${process.cwd()}); ` +
            'run "tgbackup init" or pass --config <path>',
    );
}

function parseProxyUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new UsageError(`invalid proxy url: ${url}`);
    }

    const protocol = parsed.protocol.replace(':', '').toLowerCase();
    if (!['socks5', 'socks5h', 'socks4', 'socks4a'].includes(protocol)) {
        throw new UsageError(`unsupported proxy scheme "${protocol}" (use socks5 or socks4)`);
    }
    if (!parsed.hostname || !parsed.port) {
        throw new UsageError(`proxy url must include host and port: ${url}`);
    }

    return {
        type: protocol.startsWith('socks4') ? 'socks4' : 'socks5',
        host: parsed.hostname,
        port: Number(parsed.port),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        // GramJS interprets this as seconds.
        timeout: 30,
    };
}

function normalizeProxy(value) {
    if (!value) return null;
    if (typeof value === 'string') return parseProxyUrl(value);

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new UsageError('proxy must be a socks URL string or an object');
    }
    if (value.enabled === false) return null;
    if (value.url) return parseProxyUrl(value.url);

    const type = String(value.type || value.socks_type || 'socks5').toLowerCase();
    if (!['socks4', 'socks5', 'socks5h'].includes(type)) {
        throw new UsageError(`unsupported proxy type "${type}" (use socks4 or socks5)`);
    }
    const host = value.host || value.ip;
    const port = Number(value.port);
    if (!host) throw new UsageError('proxy.host is required');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new UsageError(`proxy.port is invalid: ${value.port}`);
    }

    return {
        type: type === 'socks4' ? 'socks4' : 'socks5',
        host,
        port,
        username: value.username ? String(value.username) : undefined,
        password: value.password ? String(value.password) : undefined,
        // GramJS interprets this as seconds.
        timeout: Number.isFinite(Number(value.timeout)) && Number(value.timeout) > 0 ? Number(value.timeout) : 30,
    };
}

function proxyFromEnvironment() {
    const explicit = envValue('TGBACKUP_PROXY');
    if (explicit) return explicit;
    for (const name of ['SOCKS_PROXY', 'socks_proxy', 'ALL_PROXY', 'all_proxy']) {
        const value = envValue(name);
        if (value && /^socks/i.test(value)) return value;
    }
    return undefined;
}

function normalizeUploadDelay(value) {
    let min = 2;
    let max = 10;

    if (typeof value === 'number' || typeof value === 'string') {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) {
            throw new UsageError('upload_delay must be a non-negative number of seconds');
        }
        min = seconds;
        max = seconds;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        min = Number(value.min ?? min);
        max = Number(value.max ?? max);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
            throw new UsageError('upload_delay.min/max must be non-negative numbers');
        }
        if (min > max) throw new UsageError('upload_delay.min must not exceed upload_delay.max');
    } else if (value !== undefined && value !== null) {
        throw new UsageError('upload_delay must be a number or { min, max }');
    }

    return { minMs: Math.round(min * 1000), maxMs: Math.round(max * 1000) };
}

function normalizeUploadWorkers(value, label = 'upload_workers') {
    const workers = Number(value ?? DEFAULT_UPLOAD_WORKERS);
    if (!Number.isInteger(workers) || workers < 1 || workers > MAX_UPLOAD_WORKERS) {
        throw new UsageError(`${label} must be an integer between 1 and ${MAX_UPLOAD_WORKERS}`);
    }
    return workers;
}

function normalizeBooleanish(value, label, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off', 'none'].includes(text)) return false;
    throw new UsageError(`${label} must be a boolean (true/false)`);
}

function normalizeConfig(raw, { configPath, baseDir }) {
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        throw new UsageError('config root must be a YAML mapping');
    }
    const data = raw || {};
    const telegram = data.telegram || {};

    const apiId = Number(envValue('TGBACKUP_API_ID') ?? telegram.api_id);
    if (!Number.isInteger(apiId) || apiId <= 0) {
        throw new UsageError('telegram.api_id is missing or invalid');
    }
    const apiHash = String(envValue('TGBACKUP_API_HASH') ?? telegram.api_hash ?? '');
    if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
        throw new UsageError('telegram.api_hash must be a 32-character hex string');
    }

    const target = envValue('TGBACKUP_TARGET') ?? telegram.channel ?? telegram.target ?? telegram.my_id;
    if (target === undefined || target === null || String(target).trim() === '') {
        throw new UsageError('telegram.channel (destination chat) is missing');
    }

    const premium = Boolean(telegram.premium ?? data.premium);
    const partSize = Number(envValue('TGBACKUP_PART_SIZE') ?? data.part_size ?? DEFAULT_PART_SIZE);
    if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE) {
        throw new UsageError(`part_size must be an integer >= ${MIN_PART_SIZE} bytes`);
    }
    const partLimit = premium ? PART_LIMIT_PREMIUM : PART_LIMIT_STANDARD;
    if (partSize > partLimit) {
        throw new UsageError(
            `part_size ${partSize} exceeds the ${premium ? '4 GiB' : '2 GiB'} limit; ` +
                'enable telegram.premium for larger parts',
        );
    }

    const zstdLevel = Number(envValue('TGBACKUP_ZSTD_LEVEL') ?? data.zstd_level ?? DEFAULT_ZSTD_LEVEL);
    if (!Number.isInteger(zstdLevel) || zstdLevel < 1 || zstdLevel > 22) {
        throw new UsageError('zstd_level must be an integer between 1 and 22');
    }

    const uploadWorkers = normalizeUploadWorkers(
        envValue('TGBACKUP_UPLOAD_WORKERS') ?? data.upload_workers,
    );

    const stageArchive = normalizeBooleanish(
        envValue('TGBACKUP_STAGE_ARCHIVE') ?? data.stage_archive,
        'stage_archive',
        true,
    );

    const uploadDelay = normalizeUploadDelay(
        data.upload_delay === undefined
            ? {
                  min: envValue('TGBACKUP_DELAY_MIN') ?? 2,
                  max: envValue('TGBACKUP_DELAY_MAX') ?? 10,
              }
            : data.upload_delay,
    );

    const tmpDirValue = envValue('TGBACKUP_TMP_DIR') ?? data.tmp_dir ?? 'tmp';
    const masterKeyFileValue = envValue('TGBACKUP_MASTER_KEY_FILE') ?? data.master_key_file ?? 'master.key';
    const sessionFileValue = envValue('TGBACKUP_SESSION_FILE') ?? telegram.session_file ?? 'session.txt';

    const connectTimeoutSeconds = Number(
        envValue('TGBACKUP_CONNECT_TIMEOUT') ?? data.connect_timeout ?? 60,
    );
    if (!Number.isFinite(connectTimeoutSeconds) || connectTimeoutSeconds <= 0 || connectTimeoutSeconds > 600) {
        throw new UsageError('connect_timeout must be between 1 and 600 seconds');
    }

    const downloadStallSeconds = Number(
        envValue('TGBACKUP_DOWNLOAD_STALL_TIMEOUT') ??
            data.download_stall_timeout ??
            DEFAULT_DOWNLOAD_STALL_SECONDS,
    );
    if (!Number.isInteger(downloadStallSeconds) || downloadStallSeconds < 0 || downloadStallSeconds > 7200) {
        throw new UsageError('download_stall_timeout must be an integer between 0 and 7200 seconds (0 disables it)');
    }

    return {
        configPath,
        baseDir,
        apiId,
        apiHash,
        target: String(target),
        prefix: String(envValue('TGBACKUP_PREFIX') ?? data.prefix ?? 'tgbackup'),
        partSize,
        zstdLevel,
        uploadWorkers,
        stageArchive,
        uploadDelay,
        connectTimeoutMs: Math.round(connectTimeoutSeconds * 1000),
        downloadStallMs: downloadStallSeconds * 1000,
        premium,
        tmpDir: path.resolve(baseDir, tmpDirValue),
        masterKeyFile: path.resolve(baseDir, masterKeyFileValue),
        masterKey: envValue('TGBACKUP_MASTER_KEY'),
        sessionFile: path.resolve(baseDir, sessionFileValue),
        session: typeof telegram.session === 'string' && telegram.session.trim() ? telegram.session.trim() : null,
        proxy: normalizeProxy(proxyFromEnvironment() ?? data.proxy),
    };
}

function loadConfig(options = {}) {
    const configPath = resolveConfigPath(options.configPath);
    const baseDir = path.dirname(configPath);
    let raw;
    try {
        raw = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        throw new UsageError(`cannot parse ${configPath}: ${error.message}`);
    }
    return normalizeConfig(raw, { configPath, baseDir });
}

module.exports = {
    DEFAULT_PART_SIZE,
    DEFAULT_ZSTD_LEVEL,
    DEFAULT_UPLOAD_WORKERS,
    DEFAULT_DOWNLOAD_STALL_SECONDS,
    MAX_UPLOAD_WORKERS,
    PART_LIMIT_STANDARD,
    PART_LIMIT_PREMIUM,
    resolveConfigPath,
    normalizeProxy,
    normalizeUploadDelay,
    normalizeUploadWorkers,
    normalizeConfig,
    loadConfig,
};
