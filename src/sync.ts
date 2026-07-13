import { requestUrl } from 'obsidian';
import type http from 'http';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface RequestResult {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

export interface PropfindEntry {
  href: string;
  etag: string;
  isCollection: boolean;
  contentLength?: number;
}

export interface DownloadResult {
  data: Uint8Array;
  etag: string | null;
}

export interface UploadProgress {
  fileName: string;
  chunk: number;
  totalChunks: number;
  speed: string;
  pct: string;
}

export interface DownloadProgress {
  chunk: number;
  totalChunks: number;
  speed: string;
  pct: string;
}

export class WebDAVSync {
  private url: string;
  private username: string;
  private password: string;
  private allowSelfSigned: boolean;
  private isMobile: boolean;
  private chunkSizeMb: number = 90;

  private static readonly CHUNK_DOWNLOAD_SIZE = 10 * 1024 * 1024; // 10 MB per parallel chunk
  private static readonly PARALLEL_DOWNLOAD_THRESHOLD = 5 * 1024 * 1024; // 5 MB – below this, download whole file

  private static sleep(ms = 5): Promise<void> {
    return new Promise(r => window.setTimeout(r, ms));
  }

  private static readonly PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

  constructor(url: string, username: string, password: string, allowSelfSigned = false, chunkSizeMb = 90, isMobile = false) {
    this.url = url.replace(/\/?$/, '/');
    this.username = username;
    this.password = password;
    this.allowSelfSigned = allowSelfSigned;
    this.chunkSizeMb = chunkSizeMb;
    this.isMobile = isMobile;
  }

  updateConfig(url: string, username: string, password: string, allowSelfSigned?: boolean, chunkSizeMb?: number, isMobile?: boolean): void {
    this.url = url.replace(/\/?$/, '/');
    this.username = username;
    this.password = password;
    if (allowSelfSigned !== undefined) this.allowSelfSigned = allowSelfSigned;
    if (chunkSizeMb !== undefined) this.chunkSizeMb = chunkSizeMb;
    if (isMobile !== undefined) this.isMobile = isMobile;
  }

  private getAuthHeader(): string {
    return 'Basic ' + btoa(`${this.username}:${this.password}`);
  }

  private getFullUrl(path: string): string {
    return this.url + path;
  }

  private uint8ArrayToBuffer(data: Uint8Array): ArrayBuffer {
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
      return data.buffer;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  private async makeRequest(method: string, fullUrl: string, headers: Record<string, string>, body?: ArrayBuffer, timeoutMs = 30000): Promise<RequestResult> {
    if (!this.allowSelfSigned || this.isMobile) return this.makeRequestViaObsidian(method, fullUrl, headers, body, timeoutMs);

    const rejectUnauthorized = false;
    let lastErr: Error | undefined;
    for (let nodeRetries = 0; nodeRetries < 3; nodeRetries++) {
      try {
        const res = await this.makeRequestViaNode(method, fullUrl, headers, body, timeoutMs, rejectUnauthorized);
        if (res.status >= 500) {
          if (nodeRetries < 2) {
            await WebDAVSync.sleep(1000 * (nodeRetries + 1));
            continue;
          }
          console.warn(`[makeRequest] Node.js returned HTTP ${res.status} after ${nodeRetries + 1} retries for ${method} ${fullUrl}, falling back to Obsidian`);
          return this.makeRequestViaObsidian(method, fullUrl, headers, body, timeoutMs);
        }
        return res;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const msg = lastErr.message;
        if (msg.includes('certificate') || msg.includes('CERT') || msg.includes('UNABLE_TO_VERIFY')) {
          setEnvTlsReject(true);
          return this.makeRequestViaObsidian(method, fullUrl, headers, body, timeoutMs);
        }
        if (nodeRetries < 2) {
          console.warn(`[makeRequest] Node.js attempt ${nodeRetries + 1} failed for ${method} ${fullUrl}: ${msg}, retrying...`);
          await WebDAVSync.sleep(2000 * (nodeRetries + 1));
          continue;
        }
      }
    }
    console.warn(`[makeRequest] Node.js failed after 3 retries for ${method} ${fullUrl}, falling back to Obsidian: ${lastErr?.message || 'unknown error'}`);
    return this.makeRequestViaObsidian(method, fullUrl, headers, body, timeoutMs);
  }

  private async makeRequestViaObsidian(method: string, fullUrl: string, headers: Record<string, string>, body?: ArrayBuffer, timeoutMs?: number): Promise<RequestResult> {
    const obsHeaders = { ...headers };
    delete obsHeaders['Content-Length'];
    delete obsHeaders['OC-Chunked'];
    const response = await requestUrl({
      url: fullUrl,
      method,
      headers: obsHeaders,
      body,
      throw: false,
      timeout: timeoutMs,
    });
    const headersLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers || {})) {
      headersLower[k.toLowerCase()] = v;
    }
    return { status: response.status, headers: headersLower, arrayBuffer: response.arrayBuffer, text: response.text };
  }

  // Dynamic import avoids bundling Node.js built-ins on mobile; only invoked on desktop
  /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Node.js http/https types not resolvable by eslint when moduleResolution:bundler */
  private async makeRequestViaNode(method: string, fullUrl: string, headers: Record<string, string>, body?: ArrayBuffer, timeoutMs = 30000, rejectUnauthorized = false): Promise<RequestResult> {
    const httpsMod = await import('https');
    const httpMod = await import('http');
    return new Promise<RequestResult>((resolve, reject) => {
      const urlObj = new URL(fullUrl);
      const isHttps = urlObj.protocol === 'https:';

      if (body && !headers['Content-Length']) {
        headers['Content-Length'] = String(body.byteLength);
      }
      const opts: http.RequestOptions = {
        hostname: urlObj.hostname,
        port: parseInt(urlObj.port || (isHttps ? '443' : '80'), 10),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: { 'User-Agent': 'Obsidian WebDAV Sync Plugin/1.0', ...headers },
      };

      const onResponse = (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          const text = (() => { try { return data.toString('utf-8'); } catch { return ''; } })();
          const headersOut: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers ?? {})) {
            headersOut[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          }
          resolve({ status: res.statusCode ?? 500, headers: headersOut, arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), text });
        });
      };

      const onError = (err: Error) => {
        if (err.message?.includes('EPIPE') || err.message?.includes('socket hang up')) {
          const bodySize = body ? ` (body size: ${body.byteLength} bytes)` : '';
          reject(new Error(`Connection closed by server during request${bodySize} — EPIPE/socket hang up. The server may have a request size limit or does not support the requested operation.`));
        } else {
          reject(new Error(String(err)));
        }
      };

      let req: http.ClientRequest;
      if (isHttps) {
        req = httpsMod.request({ ...opts, rejectUnauthorized, agent: new httpsMod.Agent({ rejectUnauthorized }) }, onResponse);
      } else {
        req = httpMod.request(opts, onResponse);
      }
      req.on('error', onError);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timeout')); });
      if (body) req.write(Buffer.from(body));
      req.end();
    });
  }
  /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- Node.js http/https types not resolvable by eslint when moduleResolution:bundler */
  async testConnection(): Promise<void> {
    const response = await this.makeRequest('PROPFIND', this.url, { Depth: '0', Authorization: this.getAuthHeader() });
    if (response.status >= 400) throw new Error(`WebDAV connection failed (HTTP ${response.status})`);
  }

  async ensureDirectory(dirPath: string): Promise<void> {
    const parts = dirPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
      current += part + '/';
      try { await this.createDirectory(current); } catch { /* dir may already exist */ }
    }
  }

  async createDirectory(dirPath: string): Promise<void> {
    const fullUrl = this.getFullUrl(dirPath.replace(/\/?$/, '/'));
    const response = await this.makeRequest('MKCOL', fullUrl, { Authorization: this.getAuthHeader() });
    if (response.status !== 201 && response.status !== 405 && response.status !== 409)
      throw new Error(`MKCOL failed for ${dirPath} (HTTP ${response.status})`);
  }

  async listTree(remoteDir: string): Promise<PropfindEntry[]> {
    const results: PropfindEntry[] = [];
    const queue: string[] = [remoteDir.replace(/\/$/, '')];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: PropfindEntry[];
      try {
        entries = await this.listDirectory(dir);
      } catch (e) {
        console.warn(`Failed to list ${dir}:`, e);
        continue;
      }
      for (const entry of entries) {
        if (entry.href === '' || entry.href === dir) continue;
        if (seen.has(entry.href)) continue;
        seen.add(entry.href);
        results.push(entry);
        if (entry.isCollection) {
          queue.push(entry.href);
        }
      }
    }
    return results;
  }

  async listDirectory(dirPath: string): Promise<PropfindEntry[]> {
    const fullUrl = this.getFullUrl(dirPath.replace(/\/?$/, '/'));
    const bodyBuf = new TextEncoder().encode(WebDAVSync.PROPFIND_BODY).buffer;
    const response = await this.makeRequest('PROPFIND', fullUrl, {
      Depth: '1',
      'Content-Type': 'application/xml; charset="utf-8"',
      Authorization: this.getAuthHeader(),
    }, bodyBuf);
    if (response.status >= 400)
      throw new Error(`PROPFIND failed for ${dirPath} (HTTP ${response.status})`);
    return this.parsePropfindMultistatus(response.text);
  }

  async uploadFile(path: string, data: Uint8Array, ifMatch?: string, onProgress?: (p: UploadProgress) => void, displayName?: string): Promise<string | null> {
    const chunkSizeBytes = this.chunkSizeMb * 1024 * 1024;
    const fileSizeMb = (data.length / (1024 * 1024)).toFixed(1);
    const useChunked = data.length > chunkSizeBytes;

    if (useChunked) {
      console.log(`[uploadFile] File size ${fileSizeMb}MB > chunkSize ${this.chunkSizeMb}MB, trying chunked upload`);
      try {
        return await this.chunkedUpload(path, data, ifMatch, onProgress, displayName);
      } catch (e) {
        console.warn(`[uploadFile] Chunked upload failed, falling back to regular PUT: ${errorMessage(e)}`);
      }
    } else {
      console.log(`[uploadFile] File size ${fileSizeMb}MB <= chunkSize ${this.chunkSizeMb}MB, using regular PUT`);
    }

    const dataSizeMb = (data.length / (1024 * 1024)).toFixed(1);
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      'Content-Type': 'application/octet-stream',
    };
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    const timeout = Math.max(300000, chunkSizeBytes / 10000);
    const logName = displayName || path;
    console.log(`[uploadFile] PUT ${logName} (${dataSizeMb}MB, timeout=${timeout}ms)`);
    await new Promise(r => window.setTimeout(r, 5));
    let response: RequestResult;
    const putStart = Date.now();
    if (onProgress) onProgress({ fileName: logName, chunk: 0, totalChunks: 1, speed: '', pct: '0.0' });
    try {
      response = await this.makeRequest('PUT', this.getFullUrl(path), headers, this.uint8ArrayToBuffer(data), timeout);
      console.log(`[uploadFile] PUT ${logName} status: ${response.status}`);
    } catch (e: unknown) {
      const msg = `Upload failed for ${logName}: ${errorMessage(e)}`;
      console.error(`[uploadFile] PUT ${logName} threw: ${errorMessage(e)}`);
      if (errorMessage(e).includes('EPIPE') || errorMessage(e).includes('socket hang up')) {
        throw new Error(`${msg}\n\nThe server closed the connection during upload. This usually means the file is too large for a single PUT request or the server does not support Nextcloud's chunked upload protocol (OC-Chunked).\nOptions:\n1. Ensure your WebDAV URL is a Nextcloud instance\n2. Try reducing the chunk size in Advanced settings\n3. If not using Nextcloud, consider a server that supports larger uploads`);
      }
      throw new Error(msg);
    }
    const putElapsed = (Date.now() - putStart) / 1000;
    const putSpeed = putElapsed > 0 ? `${(data.length / putElapsed / 1048576).toFixed(1)}MB/s` : '';
    if (onProgress) onProgress({ fileName: logName, chunk: 1, totalChunks: 1, speed: putSpeed, pct: '100.0' });
    if (ifMatch !== undefined && response.status === 412) return null;
    if (response.status >= 400) throw new Error(`Upload failed for ${path} (HTTP ${response.status})`);
    return response.headers['etag'] || null;
  }

  private async chunkedUpload(remotePath: string, data: Uint8Array, ifMatch?: string, onProgress?: (p: UploadProgress) => void, displayName?: string): Promise<string | null> {
    const chunkSizeBytes = this.chunkSizeMb * 1024 * 1024;
    const uploadId = this.generateUploadId();
    const uploadBaseUrl = this.getUploadsBaseUrl();
    const auth = this.getAuthHeader();

    const uploadDirUrl = `${uploadBaseUrl}${uploadId}/`;
    const targetUrl = this.getFullUrl(remotePath);
    const timeout = Math.max(300000, chunkSizeBytes / 10000); // 5min min, scales with chunk size

    const totalChunks = Math.ceil(data.length / chunkSizeBytes);
    const shortName = displayName || remotePath.split('/').pop() || remotePath;

    const logName = displayName || remotePath;
    const fileSizeMb = (data.length / (1024 * 1024)).toFixed(1);
    console.log(`[chunkedUpload] Starting. file=${logName}, size=${fileSizeMb}MB, totalChunks=${totalChunks}, chunkSize=${this.chunkSizeMb}MB`);
    console.log(`[chunkedUpload] Uploads endpoint URL: ${uploadBaseUrl}`);
    console.log(`[chunkedUpload] Upload dir URL: ${uploadDirUrl}`);
    console.log(`[chunkedUpload] Target URL: ${targetUrl}`);

    // Create upload directory
    console.log(`[chunkedUpload] MKCOL → ${uploadDirUrl}`);
    let mkcolRes: RequestResult;
    try {
      mkcolRes = await this.makeRequest('MKCOL', uploadDirUrl, { Authorization: auth });
      console.log(`[chunkedUpload] MKCOL status: ${mkcolRes.status}`);
    } catch (e) {
      console.log(`[chunkedUpload] MKCOL threw: ${errorMessage(e)}`);
      throw new Error(`Chunked upload: MKCOL failed for upload directory — ${errorMessage(e)}. Uploads endpoint: ${uploadBaseUrl}. Make sure the WebDAV URL is a Nextcloud instance and the user ID is correct.`);
    }
    if (mkcolRes.status >= 400 && mkcolRes.status !== 405) {
      throw new Error(`Chunked upload: failed to create upload directory (HTTP ${mkcolRes.status}). Uploads endpoint: ${uploadBaseUrl}. Check that the WebDAV URL is a Nextcloud instance and the user ID is correct.`);
    }

    // Upload each chunk
    const uploadStart = Date.now();
    let bytesUploaded = 0;
    for (let i = 0; i < totalChunks; i++) {
      await new Promise(r => window.setTimeout(r, 5));
      const start = i * chunkSizeBytes;
      const end = Math.min(start + chunkSizeBytes, data.length);
      const chunk = data.slice(start, end);
      const chunkName = String(i + 1).padStart(10, '0');
      const chunkUrl = `${uploadDirUrl}${chunkName}`;
      const chunkSizeKb = (chunk.length / 1024).toFixed(0);

      let putRes: RequestResult;
      let chunkAttempts = 0;
      const MAX_CHUNK_RETRIES = 3;
      while (chunkAttempts < MAX_CHUNK_RETRIES) {
        chunkAttempts++;
        console.log(`[chunkedUpload] PUT chunk ${i + 1}/${totalChunks} (attempt ${chunkAttempts}/${MAX_CHUNK_RETRIES}, ${chunkSizeKb}KB) → ${chunkUrl}`);
        try {
          putRes = await this.makeRequest('PUT', chunkUrl, {
            Authorization: auth,
            'Content-Type': 'application/octet-stream',
            'OC-Chunked': '1',
          }, this.uint8ArrayToBuffer(chunk), timeout);
          console.log(`[chunkedUpload] Chunk ${i + 1} PUT status: ${putRes.status}`);
        } catch (e) {
          console.log(`[chunkedUpload] Chunk ${i + 1} PUT threw: ${errorMessage(e)}`);
          if (chunkAttempts >= MAX_CHUNK_RETRIES)
            throw new Error(`Chunked upload: chunk ${i + 1}/${totalChunks} failed for ${logName} — ${errorMessage(e)}`);
          await WebDAVSync.sleep(2000 * chunkAttempts);
          continue;
        }

        if (putRes.status >= 400) {
          if (chunkAttempts >= MAX_CHUNK_RETRIES)
            throw new Error(`Chunked upload: chunk ${i + 1}/${totalChunks} failed for ${logName} (HTTP ${putRes.status})`);
          console.log(`[chunkedUpload] Retrying chunk ${i + 1} after HTTP ${putRes.status}...`);
          await WebDAVSync.sleep(2000 * chunkAttempts);
          continue;
        }
        bytesUploaded += chunk.length;
        const elapsed = (Date.now() - uploadStart) / 1000;
        const speedBps = elapsed > 0 ? bytesUploaded / elapsed : 0;
        const speedStr = speedBps >= 1048576 ? `${(speedBps / 1048576).toFixed(1)}MB/s` : `${(speedBps / 1024).toFixed(0)}KB/s`;
        const pct = ((bytesUploaded / data.length) * 100).toFixed(1);
        if (onProgress) onProgress({ fileName: shortName, chunk: i + 1, totalChunks, speed: speedStr, pct });
        break;
      }
    }

    // Assemble chunks
    const assembleUrl = `${uploadDirUrl}.file`;
    console.log(`[chunkedUpload] MOVE assemble → ${assembleUrl}, Destination: ${targetUrl}`);
    let moveRes: RequestResult;
    try {
      moveRes = await this.makeRequest('MOVE', assembleUrl, {
        Authorization: auth,
        Destination: targetUrl,
        'OC-Assemble': '1',
      });
      console.log(`[chunkedUpload] MOVE status: ${moveRes.status}`);
    } catch (e) {
      console.log(`[chunkedUpload] MOVE threw: ${errorMessage(e)}`);
      throw new Error(`Chunked upload assembly failed for ${logName} — ${errorMessage(e)}`);
    }

    if (moveRes.status >= 400) {
      throw new Error(`Chunked upload assembly failed for ${logName} (HTTP ${moveRes.status})`);
    }

    console.log(`[chunkedUpload] Successfully uploaded ${logName}`);

    // Verify assembled file has content (retry if still 0)
    const expectedSize = data.length;
    for (let v = 0; v < 5; v++) {
      await WebDAVSync.sleep(1000);
      try {
        const propRes = await this.makeRequest('PROPFIND', targetUrl, {
          Depth: '0',
          Authorization: auth,
        });
        if (propRes.status < 400) {
          const entries = this.parsePropfindMultistatus(propRes.text);
          if (entries.length > 0) {
            const size = entries[0].contentLength || 0;
            console.log(`[chunkedUpload] Verified assembled file: ${size} bytes (expected ${expectedSize})`);
            if (size >= expectedSize) {
              return entries[0].etag || null;
            }
            if (size > 0) {
              console.warn(`[chunkedUpload] Assembled file size ${size} < expected ${expectedSize}, retrying verification...`);
            } else {
              console.warn(`[chunkedUpload] Assembled file still 0 bytes, retrying...`);
            }
          }
        }
      } catch { /* retry */ }
    }
    console.warn(`[chunkedUpload] File size check failed after 5 retries, proceeding with etag from headers`);

    try {
      const propRes = await this.makeRequest('PROPFIND', targetUrl, {
        Depth: '0',
        Authorization: auth,
      });
      if (propRes.status < 400) {
        const entries = this.parsePropfindMultistatus(propRes.text);
        if (entries.length > 0 && entries[0].etag) {
          return entries[0].etag;
        }
      }
    } catch {
      // non-critical
    }

    return null;
  }

  private getOriginUrl(): string {
    const u = new URL(this.url);
    return `${u.protocol}//${u.host}`;
  }

  private getUploadsBaseUrl(): string {
    const u = new URL(this.url);
    for (const part of ['files', 'dav/files']) {
      const idx = u.pathname.indexOf(`/${part}/`);
      if (idx >= 0) {
        const afterPart = u.pathname.substring(idx + part.length + 2);
        const userId = afterPart.split('/')[0];
        const base = u.pathname.substring(0, idx);
        return `${u.protocol}//${u.host}${base}/uploads/${userId}/`;
      }
    }
    // fallback: try common pattern
    const match = u.pathname.match(/\/remote\.php\/dav\/files\/([^/]+)/);
    if (match) {
      const base = u.pathname.substring(0, u.pathname.indexOf('/remote.php'));
      return `${u.protocol}//${u.host}${base}/remote.php/dav/uploads/${match[1]}/`;
    }
    throw new Error('Cannot detect Nextcloud uploads endpoint from URL. Make sure your WebDAV URL follows the pattern: https://example.com/remote.php/dav/files/{username}/...');
  }

  private generateUploadId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async downloadFile(path: string, onProgress?: (p: DownloadProgress) => void): Promise<DownloadResult> {
    const auth = { Authorization: this.getAuthHeader() };
    const url = this.getFullUrl(path);
    const CHUNK_TIMEOUT = 60000;
    const MAX_RETRIES = 3;

    let contentLength = 0;
    let etag: string | null = null;
    try {
      const headRes = await this.makeRequest('HEAD', url, auth);
      if (headRes.status < 400) {
        contentLength = parseInt(headRes.headers['content-length'] || '0', 10);
        etag = headRes.headers['etag'] || null;
      }
    } catch { /* HEAD may fail for non-existent or large files */ }

    if (contentLength <= WebDAVSync.PARALLEL_DOWNLOAD_THRESHOLD) {
      const res = await this.makeRequest('GET', url, auth);
      if (res.status >= 400) throw new Error(`Download failed for ${path} (HTTP ${res.status})`);
      return { data: new Uint8Array(res.arrayBuffer), etag: etag || res.headers['etag'] || null };
    }

    const ranges: { start: number; end: number }[] = [];
    for (let s = 0; s < contentLength; s += WebDAVSync.CHUNK_DOWNLOAD_SIZE) {
      const e = Math.min(s + WebDAVSync.CHUNK_DOWNLOAD_SIZE - 1, contentLength - 1);
      ranges.push({ start: s, end: e });
    }

    const totalChunks = ranges.length;
    const dlStart = Date.now();
    let dlBytes = 0;

    const fetchOne = async (r: { start: number; end: number }, i: number): Promise<RequestResult> => {
      let lastErr: Error | undefined;
      for (let a = 1; a <= MAX_RETRIES; a++) {
        try {
          const res = await this.makeRequest('GET', url, {
            Authorization: auth.Authorization,
            Range: `bytes=${r.start}-${r.end}`,
          }, undefined, CHUNK_TIMEOUT);
          if (res.status === 206) {
            dlBytes += res.arrayBuffer.byteLength;
            const dlElapsed = (Date.now() - dlStart) / 1000;
            const dlSpeedBps = dlElapsed > 0 ? dlBytes / dlElapsed : 0;
            const dlSpeed = dlSpeedBps >= 1048576 ? `${(dlSpeedBps / 1048576).toFixed(1)}MB/s` : `${(dlSpeedBps / 1024).toFixed(0)}KB/s`;
            const dlPct = ((dlBytes / contentLength) * 100).toFixed(1);
            if (onProgress) onProgress({ chunk: i + 1, totalChunks, speed: dlSpeed, pct: dlPct });
            return res;
          }
          lastErr = new Error(`HTTP ${res.status}`);
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
        }
        if (a < MAX_RETRIES) await WebDAVSync.sleep();
      }
      throw lastErr || new Error('Chunk download failed after retries');
    };

    let results: RequestResult[];
    try {
      results = await Promise.all(ranges.map((r, i) => fetchOne(r, i)));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[downloadFile] Chunk download failed after ${MAX_RETRIES} retries: ${errMsg}, falling back to single GET`);
      let lastErr: Error | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const fallback = await this.makeRequest('GET', url, auth, undefined, CHUNK_TIMEOUT * 2);
          if (fallback.status < 400) {
            return { data: new Uint8Array(fallback.arrayBuffer), etag: etag || fallback.headers['etag'] || null };
          }
          lastErr = new Error(`HTTP ${fallback.status}`);
        } catch (e2) {
          lastErr = e2 instanceof Error ? e2 : new Error(String(e2));
        }
        if (attempt < 3) await WebDAVSync.sleep(2000 * attempt);
      }
      throw lastErr || new Error(`Download failed for ${path}`);
    }

    const totalSize = results.reduce((s, r) => s + r.arrayBuffer.byteLength, 0);
    const data = new Uint8Array(totalSize);
    let offset = 0;
    for (const res of results) {
      data.set(new Uint8Array(res.arrayBuffer), offset);
      offset += res.arrayBuffer.byteLength;
    }

    return { data, etag };
  }

  async deleteFile(path: string, ifMatch?: string): Promise<boolean> {
    const headers: Record<string, string> = { Authorization: this.getAuthHeader() };
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    const response = await this.makeRequest('DELETE', this.getFullUrl(path), headers);
    if (response.status === 412) return false;
    if (response.status >= 400 && response.status !== 404)
      throw new Error(`Delete failed for ${path} (HTTP ${response.status})`);
    return true;
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const response = await this.makeRequest('PROPFIND', this.getFullUrl(path), { Depth: '0', Authorization: this.getAuthHeader() });
      return response.status < 400;
    } catch { return false; }
  }

  private parsePropfindMultistatus(xml: string): PropfindEntry[] {
    const entries: PropfindEntry[] = [];
    const cleaned = this.stripXmlNs(xml);
    const respRegex = /<response\b[^>]*>([\s\S]*?)<\/response>/g;
    let m: RegExpExecArray | null;
    while ((m = respRegex.exec(cleaned)) !== null) {
      const block = m[1];
      const hrefRaw = this.extractTagText(block, 'href');
      if (!hrefRaw) continue;
      const href = this.relativePathFromHref(hrefRaw);
      if (href === null) continue;
      const etag = (this.extractTagText(block, 'getetag') || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const isCollection = this.hasEmptyTag(block, 'collection');
      const contentLengthStr = this.extractTagText(block, 'getcontentlength');
      const contentLength = contentLengthStr ? parseInt(contentLengthStr, 10) : undefined;
      entries.push({ href, etag, isCollection, contentLength: isNaN(contentLength!) ? undefined : contentLength });
    }
    return entries;
  }

  private stripXmlNs(xml: string): string {
    return xml
      .replace(/<\/([a-zA-Z0-9]+):/g, '</')
      .replace(/<([a-zA-Z0-9]+):/g, '<')
      .replace(/\s+xmlns(?::[a-zA-Z0-9]+)?="[^"]*"/g, '');
  }

  private extractTagText(xml: string, tagName: string): string | null {
    const re = new RegExp(`<${tagName}\\b[^>]*>([^<]*)<\\/${tagName}>`, 'i');
    const m = re.exec(xml);
    return m ? m[1] : null;
  }

  private hasEmptyTag(xml: string, tagName: string): boolean {
    const re = new RegExp(`<${tagName}\\b[^>]*\\/?>`, 'i');
    return re.test(xml);
  }

  private relativePathFromHref(href: string): string | null {
    href = decodeURIComponent(href.trim());
    if (href.startsWith('http://') || href.startsWith('https://')) {
      try { href = new URL(href).pathname; } catch { return null; }
    }
    const basePath = new URL(this.url).pathname.replace(/\/$/, '');
    if (href.startsWith(basePath + '/')) {
      href = href.substring(basePath.length + 1);
    } else if (href.startsWith(basePath)) {
      href = href.substring(basePath.length);
    } else {
      if (href.startsWith('/')) href = href.substring(1);
    }
    href = href.replace(/\/$/, '');
    return href || null;
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access -- process.env cast needed for env var mutation */
let envTlsRejectSet = false;
function setEnvTlsReject(state: boolean): void {
  if (state && !envTlsRejectSet) {
    (process.env as Record<string, string>)['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    envTlsRejectSet = true;
  } else if (!state && envTlsRejectSet) {
    delete (process.env as Record<string, string>)['NODE_TLS_REJECT_UNAUTHORIZED'];
    envTlsRejectSet = false;
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access -- process.env cast needed for env var mutation */


