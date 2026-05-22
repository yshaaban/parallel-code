const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INVALID_VALUE = -1;
const BASE64_LOOKUP = new Int16Array(128);
BASE64_LOOKUP.fill(BASE64_INVALID_VALUE);

for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(index)] = index;
}

function isBase64AlphabetCode(charCode: number): boolean {
  return (
    charCode < BASE64_LOOKUP.length &&
    (BASE64_LOOKUP[charCode] ?? BASE64_INVALID_VALUE) !== BASE64_INVALID_VALUE
  );
}

function readBase64Value(base64: string, index: number): number {
  const charCode = base64.charCodeAt(index);
  return charCode < BASE64_LOOKUP.length
    ? (BASE64_LOOKUP[charCode] ?? BASE64_INVALID_VALUE)
    : BASE64_INVALID_VALUE;
}

function getBase64PaddingLength(base64: string): number | null {
  const firstPaddingIndex = base64.indexOf('=');
  if (firstPaddingIndex < 0) {
    return 0;
  }

  const paddingLength = base64.length - firstPaddingIndex;
  if (paddingLength > 2) {
    return null;
  }

  for (let index = firstPaddingIndex; index < base64.length; index += 1) {
    if (base64.charCodeAt(index) !== 61) {
      return null;
    }
  }

  return paddingLength;
}

function hasCanonicalPaddingBits(base64: string, dataEnd: number, paddingLength: number): boolean {
  switch (paddingLength) {
    case 0:
      return true;
    case 1:
      return dataEnd >= 3 && (readBase64Value(base64, dataEnd - 1) & 0b11) === 0;
    case 2:
      return dataEnd >= 2 && (readBase64Value(base64, dataEnd - 1) & 0b1111) === 0;
    default:
      return false;
  }
}

export function getBase64DecodedByteLength(base64: string): number | null {
  if (base64.length === 0) {
    return 0;
  }

  if (base64.length % 4 !== 0) {
    return null;
  }

  const paddingLength = getBase64PaddingLength(base64);
  if (paddingLength === null) {
    return null;
  }

  const dataEnd = base64.length - paddingLength;
  if (dataEnd === 0 && paddingLength > 0) {
    return null;
  }

  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64AlphabetCode(base64.charCodeAt(index))) {
      return null;
    }
  }

  if (!hasCanonicalPaddingBits(base64, dataEnd, paddingLength)) {
    return null;
  }

  return (base64.length / 4) * 3 - paddingLength;
}

export function isValidBase64(base64: string): boolean {
  return getBase64DecodedByteLength(base64) !== null;
}

function decodeValidatedBase64ToUint8Array(base64: string, decodedByteLength: number): Uint8Array {
  const output = new Uint8Array(decodedByteLength);
  const paddingLength = getBase64PaddingLength(base64) ?? 0;
  const dataEnd = base64.length - paddingLength;
  let outputIndex = 0;
  for (let index = 0; index < dataEnd; ) {
    const a = readBase64Value(base64, index);
    index += 1;
    const b = readBase64Value(base64, index);
    index += 1;
    const c = index < dataEnd ? readBase64Value(base64, index) : 0;
    index += 1;
    const d = index < dataEnd ? readBase64Value(base64, index) : 0;
    index += 1;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;

    output[outputIndex] = (triplet >>> 16) & 0xff;
    outputIndex += 1;
    if (outputIndex < output.length) {
      output[outputIndex] = (triplet >>> 8) & 0xff;
      outputIndex += 1;
    }
    if (outputIndex < output.length) {
      output[outputIndex] = triplet & 0xff;
      outputIndex += 1;
    }
  }

  return output;
}

export function tryDecodeBase64ToUint8Array(base64: string): Uint8Array | null {
  const decodedByteLength = getBase64DecodedByteLength(base64);
  if (decodedByteLength === null) {
    return null;
  }

  return decodeValidatedBase64ToUint8Array(base64, decodedByteLength);
}

export function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const decoded = tryDecodeBase64ToUint8Array(base64);
  if (decoded === null) {
    throw new Error('Invalid base64 payload');
  }

  return decoded;
}
