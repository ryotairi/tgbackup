'use strict';

const fs = require('node:fs');

const paths = new Set();
let installed = false;

function add(target) {
    paths.add(target);
}

function remove(target) {
    paths.delete(target);
}

function sweep() {
    for (const target of paths) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }
    paths.clear();
}

function install() {
    if (installed) return;
    installed = true;
    const handler = (signal) => {
        sweep();
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
    process.once('exit', sweep);
}

module.exports = {
    add,
    remove,
    sweep,
    install,
};
