# WebDAV GPG Sync

**Encrypt your Obsidian vault and sync to any WebDAV cloud service. The cloud provider never sees your plaintext data.**

## Key Features

### 🔒 Full Encryption, Zero Trust for Cloud

Most sync solutions (Obsidian Sync, iCloud, Dropbox, etc.) rely on cloud-side trust — the provider **can** read your data. **Obsync WebDAV GPG uses end-to-end encryption.** All encryption happens locally; only ciphertext is sent to WebDAV:

- **File content encryption** — **OpenPGP RSA 4096-bit** public key encryption, each file stored as binary ciphertext
- **Filename / path encryption** — **AES-256-GCM** key derived from your GPG key fingerprint. Every directory and file name segment is independently encrypted and Base64URL-encoded. The WebDAV server sees only random strings
- **Directory structure hidden** — The full folder hierarchy is mapped to an equal-depth encrypted path. The cloud cannot reconstruct your folder layout
- **Private key never uploaded** — Your private key stays in local Obsidian config. Only the public key is needed to encrypt uploads

**Result: The WebDAV provider, network intermediaries, and anyone with server access see only encrypted binary blobs with random filenames. Zero content, zero titles, zero structure.**

### 🔄 Bidirectional Sync

- **ETag-based incremental sync** — only transfers changed files
- **Journal tracking** — local changes are logged for crash-safe operation
- **Automatic conflict detection** — when a file changes both locally and remotely, a conflict copy is created (`.conflicted.YYYY-MM-DD.md`)
- Full sync of file/directory creates, modifies, renames, and deletes in both directions

### ⚡ Usage

| Action | Description |
|--------|-------------|
| **Generate Key Pair** | One-click RSA 4096-bit GPG key generation |
| **Sync to WebDAV** | Push local changes (encrypted) to WebDAV, pull remote changes |
| **Restore from WebDAV** | On a new device, download and decrypt everything from WebDAV to rebuild your vault |
| **Auto Sync** | Automatically sync on file save (3-second debounce) |
| **Manual Sync** | Ribbon button + command palette |

### 🛡️ Security Design

| Layer | Scheme |
|-------|--------|
| File content encryption | OpenPGP (RSA 4096-bit) |
| Filename encryption | AES-256-GCM (key derived from GPG fingerprint + PBKDF2) |
| Random IV | Unique IV per file and per path segment |
| Encryption location | All client-side, in-browser |
| Private key storage | Local Obsidian config only |
| Config export/import | Full config export (keys, credentials) for easy migration |

### ⚙️ WebDAV Compatibility

Works with any standard WebDAV service:

- NextCloud / ownCloud
- Synology NAS
- Apache mod_dav
- Any WebDAV-capable cloud storage

Supports self-signed certificates (enable in settings).

### 🚀 Quick Start

1. Install the plugin
2. Fill in WebDAV URL, username, and password in settings
3. Set a GPG passphrase
4. Click **Generate Key Pair** to create your keys
5. Click **Sync Now** to start encrypted sync

> **Migrating to a new device**: Export the config (including keys) from the old device, import it on the new one, then use **Restore from WebDAV**.

### Excluded Paths

Defaults to `.obsidian/plugins/` and `.trash/`. Add more comma-separated path prefixes as needed.

---

**Obsync WebDAV GPG** gives you the convenience of WebDAV and self-hosted storage with the privacy of end-to-end encryption. **Your notes. Your eyes only.**
