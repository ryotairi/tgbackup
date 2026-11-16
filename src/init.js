'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { generateMasterKey } = require('./keys');
const { log, warn } = require('./log');
const { ensureDir } = require('./util');

const EXAMPLE_CONFIG = path.join(__dirname, '..', 'config.example.yml');

function runInit(options = {}) {
    const directory = path.resolve(options.dir || process.cwd());
    ensureDir(directory, 0o700);

    const masterKeyPath = path.join(directory, 'master.key');
    const configPath = path.join(directory, 'config.yml');

    if (fs.existsSync(masterKeyPath) && !options.force) {
        log(`master key already exists: ${masterKeyPath} (use --force to replace it)`);
    } else {
        if (options.force && fs.existsSync(masterKeyPath)) {
            warn('replacing the master key makes every existing backup unreadable unless you kept the old key');
        }
        fs.writeFileSync(masterKeyPath, `${generateMasterKey()}\n`, { mode: 0o600 });
        try {
            fs.chmodSync(masterKeyPath, 0o600);
        } catch {
            /* best effort */
        }
        log(`generated master key: ${masterKeyPath}`);
    }

    if (fs.existsSync(configPath) && !options.force) {
        log(`config already exists: ${configPath} (use --force to overwrite it)`);
    } else {
        fs.copyFileSync(EXAMPLE_CONFIG, configPath);
        try {
            fs.chmodSync(configPath, 0o600);
        } catch {
            /* best effort */
        }
        log(`created config: ${configPath}`);
    }

    log('');
    log('next steps:');
    log(`  1. edit ${configPath} (api_id, api_hash, channel, optional socks proxy)`);
    log('  2. tgbackup login');
    log('  3. tgbackup backup /path/to/backup');
    log('');
    log('keep master.key somewhere safe and offline; without it no backup can be decrypted');
}

module.exports = {
    runInit,
};
