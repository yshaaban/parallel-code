const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

export function b64decode(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64[b64.charCodeAt(i++)];
    const b = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}
