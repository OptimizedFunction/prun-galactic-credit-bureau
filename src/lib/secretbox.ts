// Encryption for secrets the bureau has to keep and use later (lenders' FIO API keys).
// AES-256-GCM with a random nonce per value; the key is derived from the FIO_KEY_SECRET environment secret.

const encoder = new TextEncoder();

export const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (text: string): Uint8Array => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

async function aesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`bureau-fio-key-v1:${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypts `plain`. The result is safe to store; it reveals nothing without the secret. */
export async function seal(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), encoder.encode(plain));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(cipher))}`;
}

/** Decrypts a sealed value. null if it was sealed with a different secret or has been altered. */
export async function unseal(sealed: string, secret: string): Promise<string | null> {
  const [version, iv, cipher, extra] = sealed.split('.');
  if (version !== 'v1' || !iv || !cipher || extra !== undefined) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await aesKey(secret), fromB64url(cipher));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
