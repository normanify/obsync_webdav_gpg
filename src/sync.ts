import { requestUrl } from 'obsidian';

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
}

export interface DownloadResult {
  data: Uint8Array;
  etag: string | null;
}

export interface UploadProgress {
  fileName: string;
  chunk: number;
  totalChunks: number;
}

export class WebDAVSync {
  private url: string;
  private username: string;
  private password: string;
  private allowSelfSigned: boolean;
  private chunkSizeMb: number = 90;

  private static readonly PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

  constructor(url: string, username: string, password: string, allowSelfSigned = false, chunkSizeMb = 90) {
    this.url = url.replace(/\/?$/, '/');
    this.username = username;
    this.password = password;
    this.allowSelfSigned = allowSelfSigned;
    this.chunkSizeMb = chunkSizeMb;
  }

  updateConfig(url: string, username: string, password: string, allowSelfSigned?: boolean, chunkSizeMb?: number): void {
    this.url = url.replace(/\/?$/, '/');
    this.username = username;
    this.password = password;
    if (allowSelfSigned !== undefined) this.allowSelfSigned = allowSelfSigned;
    if (chunkSizeMb !== undefined) this.chunkSizeMb = chunkSizeMb;
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
    if (!this.allowSelfSigned)
      return this.makeRequestViaObsidian(method, fullUrl, headers, body);

    try {
      return await this.makeRequestViaNode(method, fullUrl, headers, body, timeoutMs);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('certificate') || msg.includes('CERT') || msg.includes('UNABLE_TO_VERIFY')) {
        setEnvTlsReject(true);
        return this.makeRequestViaObsidian(method, fullUrl, headers, body);
      }
      throw e;
    }
  }

  private async makeRequestViaObsidian(method: string, fullUrl: string, headers: Record<string, string>, body?: ArrayBuffer): Promise<RequestResult> {
    const response = await requestUrl({ url: fullUrl, method, headers, body, throw: false });
    const headersLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(response.headers || {})) {
      headersLower[k.toLowerCase()] = v;
    }
    return { status: response.status, headers: headersLower, arrayBuffer: response.arrayBuffer, text: response.text };
  }

  private async makeRequestViaNode(method: string, fullUrl: string, headers: Record<string, string>, body?: ArrayBuffer, timeoutMs = 30000): Promise<RequestResult> {
    let https: any, http: any;
    try {
      https = require('https');
      http = require('http');
    } catch {
      throw new Error('Node.js http/https modules not available');
    }

    return new Promise((resolve, reject) => {
      const urlObj = new URL(fullUrl);
      const isHttps = urlObj.protocol === 'https:';
      const port = urlObj.port || (isHttps ? 443 : 80);
      const mod = isHttps ? https : http;
      const agent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined;

      const options: any = {
        hostname: urlObj.hostname,
        port: parseInt(port.toString(), 10),
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      };
      if (isHttps) { options.agent = agent; options.rejectUnauthorized = false; }

      const req = mod.request(options, (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 500, headers: res.headers || {}, arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), text: data.toString('utf-8') });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timeout')); });
      if (body) req.write(Buffer.from(body));
      req.end();
    });
  }

  async testConnection(): Promise<void> {
    const response = await this.makeRequest('PROPFIND', this.url, { Depth: '0', Authorization: this.getAuthHeader() });
    if (response.status >= 400) throw new Error(`WebDAV connection failed (HTTP ${response.status})`);
  }

  async ensureDirectory(dirPath: string): Promise<void> {
    const parts = dirPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
      current += part + '/';
      try { await this.createDirectory(current); } catch {}
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
    }, bodyBuf as ArrayBuffer);
    if (response.status >= 400)
      throw new Error(`PROPFIND failed for ${dirPath} (HTTP ${response.status})`);
    return this.parsePropfindMultistatus(response.text);
  }

  async uploadFile(path: string, data: Uint8Array, ifMatch?: string, onProgress?: (p: UploadProgress) => void): Promise<string | null> {
    const chunkSizeBytes = this.chunkSizeMb * 1024 * 1024;

    if (data.length > chunkSizeBytes) {
      return await this.chunkedUpload(path, data, ifMatch, onProgress);
    }

    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      'Content-Type': 'application/octet-stream',
    };
    if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    const response = await this.makeRequest('PUT', this.getFullUrl(path), headers, this.uint8ArrayToBuffer(data));
    if (ifMatch !== undefined && response.status === 412) return null;
    if (response.status >= 400) throw new Error(`Upload failed for ${path} (HTTP ${response.status})`);
    return response.headers['etag'] || null;
  }

  private async chunkedUpload(remotePath: string, data: Uint8Array, ifMatch?: string, onProgress?: (p: UploadProgress) => void): Promise<string | null> {
    const chunkSizeBytes = this.chunkSizeMb * 1024 * 1024;
    const uploadId = this.generateUploadId();
    const uploadBaseUrl = this.getUploadsBaseUrl();
    const auth = this.getAuthHeader();

    const uploadDirUrl = `${uploadBaseUrl}${uploadId}/`;
    const targetUrl = this.getFullUrl(remotePath);
    const timeout = Math.max(300000, chunkSizeBytes / 10000); // 5min min, scales with chunk size

    const totalChunks = Math.ceil(data.length / chunkSizeBytes);
    const shortName = remotePath.split('/').pop() || remotePath;

    try {
      await this.makeRequest('MKCOL', uploadDirUrl, { Authorization: auth });
    } catch (e) {
      // collection may already exist from a previous attempt
    }

    for (let i = 0; i < totalChunks; i++) {
      if (onProgress) onProgress({ fileName: shortName, chunk: i + 1, totalChunks });

      const start = i * chunkSizeBytes;
      const end = Math.min(start + chunkSizeBytes, data.length);
      const chunk = data.slice(start, end);
      const chunkName = String(i + 1).padStart(10, '0');
      const chunkUrl = `${uploadDirUrl}${chunkName}`;

      await this.makeRequest('PUT', chunkUrl, {
        Authorization: auth,
        'Content-Type': 'application/octet-stream',
        'OC-Chunked': '1',
      }, this.uint8ArrayToBuffer(chunk), timeout);
    }

    const assembleUrl = `${uploadDirUrl}.file`;

    const moveRes = await this.makeRequest('MOVE', assembleUrl, {
      Authorization: auth,
      Destination: targetUrl,
      'OC-Assemble': '1',
    });

    if (moveRes.status >= 400) {
      throw new Error(`Chunked upload assembly failed for ${remotePath} (HTTP ${moveRes.status})`);
    }

    // Fetch etag of assembled file
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
    } catch (e) {
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
    const match = u.pathname.match(/\/remote\.php\/dav\/files\/([^\/]+)/);
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

  async downloadFile(path: string): Promise<DownloadResult> {
    const response = await this.makeRequest('GET', this.getFullUrl(path), { Authorization: this.getAuthHeader() });
    if (response.status >= 400) throw new Error(`Download failed for ${path} (HTTP ${response.status})`);
    return { data: new Uint8Array(response.arrayBuffer), etag: response.headers['etag'] || null };
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
      entries.push({ href, etag, isCollection });
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

let envTlsRejectSet = false;
function setEnvTlsReject(state: boolean): void {
  if (state && !envTlsRejectSet) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    envTlsRejectSet = true;
  } else if (!state && envTlsRejectSet) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    envTlsRejectSet = false;
  }
}
