# WebDAV GPG Sync

**File content + filenames — both encrypted. The server sees only random garbage. AES-256-GCM + RSA 4096, end-to-end encrypted sync to any WebDAV.**

## Key Features

### 🔒 Full Encryption, Zero Trust for Cloud

Most sync solutions (Obsidian Sync, iCloud, Dropbox, etc.) rely on cloud-side trust — the provider **can** read your data. **WebDAV GPG Sync uses end-to-end encryption.** All encryption happens locally; only ciphertext is sent to WebDAV:

- **✅ Filenames are encrypted too** — Not just file content: **every folder and file name** is independently encrypted with AES-256-GCM and Base64URL-encoded. The server sees only random strings and has no idea what files you're editing
- **File content encryption** — **OpenPGP RSA 4096-bit** public key encryption, each file stored as binary ciphertext
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

> **🌐 Cloudflare Proxy Compatible** — Uploads and downloads use **chunked transfer** with automatic 100MB file splitting. This avoids Cloudflare's 100MB upload limit and works reliably behind Cloudflare proxies, CDNs, and other reverse proxies that restrict request sizes. Both upload and download are fully chunked.

### 🔁 Chunked Transfer

Files **over 90MB** (configurable in Advanced settings) are automatically split into chunks for both **upload** and **download**:

- **Upload**: Uses the Nextcloud OC-Chunked protocol — chunks are uploaded individually, then assembled server-side
- **Download**: Uses HTTP `Range` requests — chunks are fetched **in parallel** (10MB per chunk) with per-chunk timeout (60s) and automatic retry (3 attempts)
- **Status bar** shows real-time chunk progress: `Uploading notes.md (3/12 · file 5/18)`
- Files under 5MB download as a single request for maximum speed

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
