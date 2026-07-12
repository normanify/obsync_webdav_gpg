import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

const PQ_MAGIC = new Uint8Array([79, 66, 83, 89, 78, 67, 45, 75]); // "OBSYNC-K"
const MAGIC_LEN = 8;
const CT_LEN = 1088;
const IV_LEN = 12;

function toBytes(v: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  return v.slice();
}

function toBuf(v: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  return v as unknown as Uint8Array<ArrayBuffer>;
}

function arraysEqual(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function kyberKeygen(): { publicKey: Uint8Array<ArrayBuffer>; secretKey: Uint8Array<ArrayBuffer> } {
  const k = ml_kem768.keygen();
  return { publicKey: toBytes(k.publicKey), secretKey: toBytes(k.secretKey) };
}

function kyberEncapsulate(pk: Uint8Array<ArrayBuffer>): { cipherText: Uint8Array<ArrayBuffer>; sharedSecret: Uint8Array<ArrayBuffer> } {
  const r = ml_kem768.encapsulate(pk);
  return { cipherText: toBytes(r.cipherText), sharedSecret: toBytes(r.sharedSecret) };
}

function kyberDecapsulate(ct: Uint8Array<ArrayBuffer>, sk: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return toBytes(ml_kem768.decapsulate(ct, sk));
}

export class CryptoManager {
  private publicKey: Uint8Array<ArrayBuffer> | null = null;
  private secretKey: Uint8Array<ArrayBuffer> | null = null;
  private fingerprint = '';

  isReady(): boolean {
    return this.publicKey !== null;
  }

  canDecrypt(): boolean {
    return this.secretKey !== null;
  }

  async generateKeyPair(): Promise<{ publicKey: string; secretKey: string }> {
    const keys = kyberKeygen();
    return {
      publicKey: bytesToBase64(keys.publicKey),
      secretKey: bytesToBase64(keys.secretKey),
    };
  }

  async loadPublicKey(b64: string): Promise<void> {
    this.publicKey = base64ToBytes(b64);
    const hash = await crypto.subtle.digest('SHA-256', this.publicKey!);
    this.fingerprint = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async loadSecretKey(b64: string): Promise<void> {
    this.secretKey = base64ToBytes(b64);
  }

  getFingerprint(): string {
    return this.fingerprint || '(no key loaded)';
  }

  async encryptText(text: string): Promise<string> {
    const enc = await this.encryptBytes(new TextEncoder().encode(text));
    return bytesToBase64(enc);
  }

  async decryptText(b64: string): Promise<string> {
    const dec = await this.decryptBytes(base64ToBytes(b64));
    return new TextDecoder().decode(dec);
  }

  async encryptBytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.publicKey) throw new Error('Public key not loaded');

    const { cipherText, sharedSecret } = kyberEncapsulate(this.publicKey);

    const aesKey = await crypto.subtle.importKey('raw', sharedSecret as BufferSource, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data));

    const result = toBuf(new Uint8Array(MAGIC_LEN + CT_LEN + IV_LEN + ciphertext.length));
    result.set(PQ_MAGIC, 0);
    result.set(cipherText, MAGIC_LEN);
    result.set(iv, MAGIC_LEN + CT_LEN);
    result.set(ciphertext, MAGIC_LEN + CT_LEN + IV_LEN);
    return result;
  }

  isPqFormat(data: Uint8Array<ArrayBuffer>): boolean {
    return data.length >= MAGIC_LEN && arraysEqual(data.subarray(0, MAGIC_LEN), PQ_MAGIC);
  }

  async decryptBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!this.secretKey) throw new Error('Secret key not loaded');

    if (!this.isPqFormat(toBuf(data))) {
      throw new Error('Unrecognized encryption format — not a valid OBSYNC-K payload');
    }

    const cipherText = toBuf(data.subarray(MAGIC_LEN, MAGIC_LEN + CT_LEN));
    const iv = toBuf(data.subarray(MAGIC_LEN + CT_LEN, MAGIC_LEN + CT_LEN + IV_LEN));
    const ciphertext = toBuf(data.subarray(MAGIC_LEN + CT_LEN + IV_LEN));

    const sharedSecret = kyberDecapsulate(cipherText, this.secretKey);

    const aesKey = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['decrypt']);
    const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext));
    return decrypted;
  }

  /* Path segment encryption (AES-256-GCM) */

  private aesKey: CryptoKey | null = null;
  private aesKeyPromise: Promise<CryptoKey> | null = null;

  private async getAESKey(): Promise<CryptoKey> {
    if (this.aesKey) return this.aesKey;
    if (this.aesKeyPromise) return this.aesKeyPromise;
    this.aesKeyPromise = this.deriveAESKey();
    this.aesKey = await this.aesKeyPromise;
    this.aesKeyPromise = null;
    return this.aesKey;
  }

  private async deriveAESKey(): Promise<CryptoKey> {
    if (!this.fingerprint) throw new Error('No key loaded — load a public key first');
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(this.fingerprint), 'PBKDF2', false, ['deriveBits', 'deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode('obsync-path-v2'), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encryptPathSegment(plain: string): Promise<Uint8Array<ArrayBuffer>> {
    const key = await this.getAESKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plain);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded));
    const combined = toBuf(new Uint8Array(iv.length + ciphertext.byteLength));
    combined.set(iv, 0);
    combined.set(ciphertext, iv.length);
    return combined;
  }

  async decryptPathSegment(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const key = await this.getAESKey();
    const iv = data.subarray(0, 12);
    const ciphertext = toBuf(data.subarray(12));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }
}
