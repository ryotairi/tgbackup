'use strict';

const { formatBytes, formatDuration } = require('./util');

/**
 * GramJS logs with console.log, which would corrupt the token on stdout.
 * Redirect every console convenience method to stderr for the lifetime of the
 * process; the token is written with process.stdout.write explicitly.
 */
function protectStdout() {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalDebug = console.debug;
    const originalError = console.error;

    const redirect = (...args) => console.error(...args);
    console.log = redirect;
    console.info = redirect;
    console.debug = redirect;

    // GramJS's keep-alive/update loop prints raw `Error: TIMEOUT` stack traces
    // via console.error whenever a ping times out (typical through flaky SOCKS
    // proxies). It reconnects on its own, so replace the scary trace with a
    // throttled one-liner instead of hiding it completely.
    let lastPingNote = 0;
    console.error = (...args) => {
        const first = args[0];
        if (
            first instanceof Error &&
            first.message === 'TIMEOUT' &&
            typeof first.stack === 'string' &&
            first.stack.includes('telegram/client/updates.js')
        ) {
            const now = Date.now();
            if (now - lastPingNote > 60000) {
                lastPingNote = now;
                originalError(
                    'telegram keep-alive ping timed out; GramJS reconnects in the background, uploads continue',
                );
            }
            return;
        }
        originalError(...args);
    };

    return () => {
        console.log = originalLog;
        console.info = originalInfo;
        console.debug = originalDebug;
        console.error = originalError;
    };
}

function log(...args) {
    console.error(...args);
}

function warn(...args) {
    console.error('warning:', ...args);
}

function createProgress(label) {
    let lastPercent = -1;
    let active = false;
    const started = Date.now();
    let lastTime = started;
    let lastDone = 0;
    let speed = 0; // smoothed bytes per second

    return {
        update(done, total) {
            const doneNum = Number(done);
            const totalNum = Number(total);
            if (!Number.isFinite(doneNum) || !Number.isFinite(totalNum) || totalNum <= 0) return;
            if (doneNum < lastDone) {
                // restarted attempt/seek: reset the rate estimator
                lastDone = doneNum;
                lastTime = Date.now();
                speed = 0;
            }

            const now = Date.now();
            const sinceLast = now - lastTime;
            if (sinceLast >= 200 && doneNum > lastDone) {
                const instant = ((doneNum - lastDone) / sinceLast) * 1000;
                speed = speed > 0 ? speed * 0.5 + instant * 0.5 : instant;
                lastTime = now;
                lastDone = doneNum;
            }

            const percent = Math.min(100, Math.max(0, (doneNum / totalNum) * 100));
            if (percent === lastPercent) return;
            if (percent - lastPercent < 1 && percent < 100) return;
            lastPercent = percent;
            active = true;

            const speedText = speed > 1024 ? `, ${formatBytes(speed)}/s` : '';
            const etaText =
                speed > 1024 && doneNum < totalNum
                    ? `, eta ${formatDuration(((totalNum - doneNum) / speed) * 1000)}`
                    : '';
            const text = `${label}: ${percent.toFixed(0).padStart(3)}% (${formatBytes(doneNum)}/${formatBytes(totalNum)}${speedText}${etaText})`;
            process.stderr.write(process.stderr.isTTY ? `\r${text.padEnd(72, ' ')}` : `${text}\n`);
            if (percent >= 100) {
                process.stderr.write('\n');
                active = false;
            }
        },
        finish() {
            if (active) {
                process.stderr.write('\n');
                active = false;
            }
        },
    };
}

function createPercentProgress(label) {
    let lastPercent = -1;
    return {
        update(percent) {
            const value = Math.min(100, Math.max(0, Number(percent) || 0));
            if (value === lastPercent) return;
            if (value - lastPercent < 1 && value < 100) return;
            lastPercent = value;
            const text = `${label}: ${value.toFixed(0).padStart(3)}%`;
            process.stderr.write(process.stderr.isTTY ? `\r${text.padEnd(72, ' ')}` : `${text}\n`);
        },
        finish() {
            if (lastPercent >= 0 && lastPercent < 100) {
                process.stderr.write('\n');
                lastPercent = 100;
            }
        },
    };
}

module.exports = {
    protectStdout,
    log,
    warn,
    createProgress,
    createPercentProgress,
};
