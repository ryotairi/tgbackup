# tgbackup

Encrypted, chunked backups stored as Telegram documents.

This is a rewrite of the old `OneBackup` scripts (tar → split → upload split parts with a
single static AES-CTR key). It keeps the same idea but fixes the dangerous parts and adds
the features the old version lacked:

| | OneBackup | tgbackup |
|---|---|---|
| Cipher | AES-256-CTR with a fixed IV, key = MD5 of a file | AES-256-GCM, per-frame nonces, authenticated |
| Keys | one static key for everything | one master key + a fresh random key per backup |
| Restore secret | the single key | token **and** master key |
| Compression | gzip | zstd (level configurable) |
| Upload pacing | none | random delay between parts |
| Proxy | none | outbound SOCKS4/SOCKS5 for every Telegram connection |
| Login | interactive on every run | session cached in a `0600` file |
| Output | `.msgids` in the CWD | self-contained base64url token (message ids + backup key) |

## How it works

```
path ──tar──▶ zstd ──▶ split ──▶ AES-GCM(backup key) ──▶ AES-GCM(master key) ──▶ Telegram
                                                                                 │
                                   token = base64url{ msg ids, backup key, meta } ◀┘
```

1. The target file/directory is tarred and compressed with zstd.
2. The stream is split into parts (`part_size`, default 256 MiB).
3. Every part is encrypted with a **random key generated for this backup**, then encrypted
   again with your **single master key**. Both layers are required to read anything.
4. Parts are uploaded as documents with a random delay between uploads.
5. The command prints one base64url token. It contains the Telegram message ids of every
   part and the random per-backup key. The master key is never included.

Restoring needs **both** the token and the master key. Losing either one makes the backup
unreadable. The Telegram chat alone is not enough: without the master key the per-backup
key cannot be used, and without the token there is no per-backup key at all.

## Requirements

- Node.js **>= 22.15** (built-in zstd; older Node has no `zlib.createZstdCompress`)
- A Telegram account, `api_id`/`api_hash` from <https://my.telegram.org>
- A private channel/chat to store the encrypted parts

## Install

```sh
npm install
npm link          # optional: puts `tgbackup` on PATH
```

## Setup

```sh
tgbackup init     # writes master.key (0600) and config.yml (0600)
$EDITOR config.yml
tgbackup login    # asks for phone/code/2FA once, saves session.txt (0600); add --qr if SMS never arrives
```

Copy `master.key` somewhere safe and offline (password manager, offline USB). It is the one
thing that cannot be recreated.

### Telegram is blocked on this network?

Every Telegram connection (initial login, uploads and downloads to other data centers) can
go through an outbound SOCKS4/SOCKS5 proxy. Run a SOCKS listener somewhere Telegram is not
blocked, for example an SSH dynamic tunnel:

```sh
ssh -N -D 1080 me@my-vps.example
```

Then enable it in `config.yml`:

```yaml
proxy:
  enabled: true
  type: socks5        # or socks4
  host: 127.0.0.1
  port: 1080
  # username: user
  # password: pass
```

or use the one-off flag / environment variable:

```sh
tgbackup check --proxy socks5://127.0.0.1:1080
TGBACKUP_PROXY=socks5://127.0.0.1:1080 tgbackup backup /srv/data
```

`tgbackup check` first tests TCP connectivity to the proxy, then opens the MTProto
connection and reports whether the cached session is valid. Use `--proxy none` to force a
direct connection. If no proxy is configured, a reachable `SOCKS_PROXY` / `ALL_PROXY`
environment variable with a `socks5://` or `socks4://` URL is used automatically.

### The login code never arrives

- Telegram sends the code as a message **inside** Telegram (from the "Telegram" service
  account) whenever you are logged in on another device. Check there before waiting for SMS.
- If SMS to your number is blocked or you have no other device, use QR login:

  ```sh
  tgbackup login --qr
  ```

  Then on your phone: **Telegram → Settings → Devices → Link Desktop Device** and scan the
  QR printed in the terminal (it expires every ~30 s and is regenerated automatically).
- `--force-sms` asks Telegram to send the code by SMS instead (only useful if SMS actually
  reaches you).
- Run `tgbackup check` first to confirm the proxy path to Telegram works; login requests fail
  silently-looking if the connection is blocked.

## Backup

```sh
tgbackup backup /srv/data
```

stdout is **only** the token, so it can be captured directly:

```sh
TOKEN=$(tgbackup backup /srv/data --non-interactive)
printf '%s\n' "$TOKEN" > backup-$(date +%F).token
```

All progress/status output goes to stderr. The token can also be written to a file:

```sh
tgbackup backup /srv/data --token-out /root/backups/data.token
```

Useful options:

| Option | Meaning |
|---|---|
| `--name <name>` | backup name used in captions/token |
| `--part-size 128M` | encrypted bytes per Telegram document |
| `--zstd-level 15` | zstd compression level (1–22) |
| `--delay 2,12` | random delay range in seconds between part uploads |
| `--token-out <file>` | write the token to a `0600` file as well |
| `--keep-tmp` | keep encrypted part files for debugging |

Parts are uploaded one at a time. Between uploads the script sleeps for a random number of
seconds (`upload_delay` in the config or `--delay`). Failed uploads/downloads are retried
with exponential backoff.

## Restore

```sh
tgbackup restore '<token>' --out /srv/restore
```

or read the token from a file/stdin:

```sh
tgbackup restore --token-file data.token --out /srv/restore
cat data.token | tgbackup restore - --out /srv/restore
```

The archive contains the original target's basename, so backup of `/srv/data` restores to
`<out>/data/...`.

## Inspect a token

```sh
tgbackup info '<token>'
tgbackup info '<token>' --json
```

No network access and no master key needed: it only decodes the token.

## Configuration

See [`config.example.yml`](config.example.yml). Highlights:

```yaml
telegram:
  api_id: 123456
  api_hash: "0123456789abcdef0123456789abcdef"
  channel: "-1001234567890"     # numeric id, @username or invite link
  session_file: ./session.txt
  premium: false                # allow parts up to 4 GiB

master_key_file: ./master.key
prefix: tgbackup
part_size: 268435456            # 256 MiB
zstd_level: 10
upload_delay:
  min: 2
  max: 10
tmp_dir: ./tmp

proxy:
  enabled: true
  type: socks5                  # socks5 or socks4
  host: 127.0.0.1
  port: 1080
  username: ""                  # optional
  password: ""                  # optional
  # url: "socks5://user:pass@127.0.0.1:1080"
```

The proxy is applied to every connection the Telegram client opens, including the upload
and download senders for other data centers.

### Environment overrides

Handy for cron/containers:

| Variable | Overrides |
|---|---|
| `TGBACKUP_CONFIG` | config path |
| `TGBACKUP_API_ID`, `TGBACKUP_API_HASH`, `TGBACKUP_TARGET` | Telegram credentials/target |
| `TGBACKUP_PROXY` | `socks5://user:pass@host:port` (falls back to a socks `SOCKS_PROXY`/`ALL_PROXY`) |
| `TGBACKUP_MASTER_KEY` | master secret (base64url/hex/passphrase), no file needed |
| `TGBACKUP_MASTER_KEY_FILE`, `TGBACKUP_SESSION_FILE`, `TGBACKUP_TMP_DIR` | paths |
| `TGBACKUP_PART_SIZE`, `TGBACKUP_ZSTD_LEVEL` | tuning |
| `TGBACKUP_CONNECT_TIMEOUT` | MTProto connect timeout in seconds |
| `TGBACKUP_DELAY_MIN`, `TGBACKUP_DELAY_MAX` | upload delay seconds |
| `TGBACKUP_DEBUG=1` | full stack traces |

A cron example:

```cron
15 3 * * * cd /root/tgbackup && TGBACKUP_MASTER_KEY_FILE=/etc/tgbackup/master.key \
  ./bin/tgbackup backup /srv/data --non-interactive --token-out /root/backups/data.token
```

## Format notes

Each part is a self-describing container:

```
"TGBK" | version:u8 | nonce_prefix:8 | (frame_len:u32be | nonce:12 | tag:16 | ciphertext)*
```

- Frames are 4 MiB of plaintext each, with independent AES-256-GCM tags.
- The 8-byte random nonce prefix + 32-bit frame counter form the nonce.
- The header is used as AAD, so frames cannot be moved between parts.
- Outer layer key = HKDF-SHA256(master secret); inner layer key = random per backup.
- Any tampering, truncation, wrong key or reordering is detected.

## Limitations

- No resume: an interrupted backup leaves uploaded parts in the chat but no token. Delete
  them manually.
- Parts are uploaded sequentially to stay gentle on Telegram rate limits.
- Telegram limits a document to 2 GiB (4 GiB with Premium); the tool validates this.
- `session.txt` grants full access to the account. Keep it `0600` and out of backups you
  upload with the same account.

## Development

```sh
npm test
```

The integration test stubs the Telegram transport and runs a full
backup → token → restore round-trip, including a wrong-master-key failure case.

> Note: the legacy `../OneBackup` directory contains live credentials and a session string.
> Rotate/terminate them in Telegram before retiring that directory.
