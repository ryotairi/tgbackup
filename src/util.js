'use strict';

const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

/** Error caused by bad user input / configuration (shown without a stack trace). */
class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
        this.exitCode = 2;
    }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return String(bytes);
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function parseSize(value, label = 'size') {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new UsageError(`invalid ${label}: ${value}`);
        return Math.round(value);
    }
    const text = String(value).trim();
    const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)(i?b?)$/i.exec(text);
    if (!match) throw new UsageError(`invalid ${label}: ${value}`);
    const factors = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
    const amount = Number(match[1]);
    const factor = factors[match[2].toLowerCase()];
    return Math.round(amount * factor);
}

function randomInt(min, max) {
    if (max <= min) return min;
    return min + Math.floor(Math.random() * (max - min + 1));
}

async function randomSleep(minMs, maxMs) {
    if (maxMs <= 0) return 0;
    const ms = randomInt(minMs, maxMs);
    await sleep(ms);
    return ms;
}

async function withRetry(fn, options = {}) {
    const {
        attempts = 3,
        baseDelayMs = 2000,
        maxDelayMs = 60000,
        onRetry,
    } = options;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt === attempts) break;
            const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) + randomInt(0, 750);
            if (onRetry) onRetry(error, attempt, delay);
            await sleep(delay);
        }
    }
    throw lastError;
}

function timestampName(prefix = 'backup') {
    const now = new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return [
        prefix,
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
        `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
    ].join('-');
}

function slugify(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'backup';
}

function ensureDir(dir, mode = 0o700) {
    fs.mkdirSync(dir, { recursive: true, mode });
    return dir;
}

function removeQuietly(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

function warnIfLoosePermissions(file) {
    if (process.platform === 'win32') return null;
    try {
        const mode = fs.statSync(file).mode & 0o777;
        if (mode & 0o077) {
            return `warning: ${file} is readable by other users (mode ${mode.toString(8)}); consider "chmod 600"`;
        }
    } catch {
        /* ignore */
    }
    return null;
}

module.exports = {
    UsageError,
    formatBytes,
    formatDuration,
    parseSize,
    randomInt,
    randomSleep,
    withRetry,
    timestampName,
    slugify,
    ensureDir,
    removeQuietly,
    warnIfLoosePermissions,
};
