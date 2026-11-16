'use strict';

const { formatBytes } = require('./util');

/**
 * GramJS logs with console.log, which would corrupt the token on stdout.
 * Redirect every console convenience method to stderr for the lifetime of the
 * process; the token is written with process.stdout.write explicitly.
 */
function protectStdout() {
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalDebug = console.debug;

    const redirect = (...args) => console.error(...args);
    console.log = redirect;
    console.info = redirect;
    console.debug = redirect;

    return () => {
        console.log = originalLog;
        console.info = originalInfo;
        console.debug = originalDebug;
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

    return {
        update(done, total) {
            if (!Number.isFinite(total) || total <= 0) return;
            const percent = Math.min(100, Math.max(0, (done / total) * 100));
            if (percent === lastPercent) return;
            if (percent - lastPercent < 1 && percent < 100) return;
            lastPercent = percent;
            active = true;
            const text = `${label}: ${percent.toFixed(0).padStart(3)}% (${formatBytes(done)}/${formatBytes(total)})`;
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
