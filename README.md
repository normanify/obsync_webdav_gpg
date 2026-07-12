# WebDAV GPG Sync

> [中文版 README](README_zh.md)

> **⚠️ v2.0.0 BREAKING CHANGE — Not backward compatible**
>
> v2.0.0 switches encryption from **RSA 4096 (OpenPGP)** to **ML-KEM-768 (NIST FIPS 203 post-quantum)**.
>
> **Old GPG keys, passphrase, and all previously encrypted remote data are INVALIDATED.** After upgrading you must:
> 1. Generate a new key pair in settings (no passphrase required)
> 2. Delete old encrypted data on your WebDAV server (or start with an empty directory)
>
> Key format changed from OpenPGP armor to base64. Settings field `privateKey` renamed to `secretKey`.

**File content + filenames — both encrypted. The server sees only random garbage. AES-256-GCM + ML-KEM-768 post-quantum, end-to-end encrypted sync to any WebDAV.**

## Key Features

### 🔒 Full Encryption, Zero Trust for Cloud

Most sync solutions (Obsidian Sync, iCloud, Dropbox, etc.) rely on cloud-side trust — the provider **can** read your data. **WebDAV PQC Sync uses end-to-end encryption.** All encryption happens locally; only ciphertext is sent to WebDAV:

- **✅ Filenames are encrypted too** — Not just file content: **every folder and file name** is independently encrypted with AES-256-GCM and Base64URL-encoded. The server sees only random strings and has no idea what files you're editing
- **File content encryption** — **ML-KEM-768 (FIPS 203)** key encapsulation + **AES-256-GCM** bulk encryption. The 32-byte shared secret from ML-KEM directly keys AES-256-GCM. Hardware-accelerated via Web Crypto API
- **Post-quantum secure** — ML-KEM-768 is the NIST-standardized replacement for RSA/ECC, resistant to Shor's algorithm attacks from quantum computers
- **Directory structure hidden** — The full folder hierarchy is mapped to an equal-depth encrypted path. The cloud cannot reconstruct your folder layout
- **Secret key never uploaded** — Your secret key stays in local Obsidian config. Only the public key is needed to encrypt uploads

**Result: The WebDAV provider, network intermediaries, and anyone with server access see only encrypted binary blobs with random filenames. Zero content, zero titles, zero structure.**

### 🔄 Bidirectional Sync

- **ETag-based incremental sync** — only transfers changed files
- **Journal tracking** — local changes are logged for crash-safe operation
- **Automatic conflict detection** — when a file changes both locally and remotely, a conflict copy is created (`.conflicted.YYYY-MM-DD.md`)
- Full sync of file/directory creates, modifies, renames, and deletes in both directions

### ⚡ Usage

| Action | Description |
|--------|-------------|
| **Generate Key Pair** | One-click ML-KEM-768 post-quantum key generation (no passphrase needed) |
| **Sync to WebDAV** | Push local changes (encrypted) to WebDAV, pull remote changes |
| **Restore from WebDAV** | On a new device, download and decrypt everything from WebDAV to rebuild your vault |
| **Auto Sync** | Automatically sync on file save (3-second debounce) |
| **Manual Sync** | Ribbon button + command palette |

### 🛡️ Security Design

| Layer | v1.x (old) | v2.0+ (current) |
|-------|-----------|------------------|
| Key encapsulation | RSA 4096 (OpenPGP) | **ML-KEM-768 (NIST FIPS 203)** — quantum-resistant |
| Bulk encryption | AES-256-GCM | AES-256-GCM (unchanged) |
| Filename encryption | AES-256-GCM (key from GPG fingerprint) | AES-256-GCM (key from SHA-256 of Kyber public key) |
| Key derivation | PBKDF2 100k iterations | PBKDF2 100k iterations (unchanged) |
| Key format | OpenPGP armored (ASCII) | **Base64-encoded raw bytes** |
| Passphrase | Required (encrypted private key) | **Removed** (keys are raw, no encryption at rest) |
| Encryption overhead | 536 bytes per file | 1108 bytes per file (+572 bytes) |
| Private key → Public key | Derivable from private key | **Must store both** (Kyber cannot derive public from secret) |
| Quantum resistant | ❌ No (RSA broken by Shor's algorithm) | **✅ Yes** |
| Bundle size | ~600 KB (OpenPGP.js) | **~72 KB** (@noble/post-quantum) |

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
3. Click **Generate Key Pair** to create your ML-KEM-768 keys
4. Click **Sync Now** to start encrypted sync

> **Migrating to a new device**: Export the config (including keys) from the old device, import it on the new one, then use **Restore from WebDAV**.

### Excluded Paths

Defaults to `.obsidian/plugins/` and `.trash/`. Add more comma-separated path prefixes as needed.

---

**Obsync WebDAV GPG/PQC Sync** gives you the convenience of WebDAV and self-hosted storage with the privacy of end-to-end post-quantum encryption. **Your notes. Your eyes only.**
