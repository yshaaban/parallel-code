const ESCAPE = 0x1b;
const CARRIAGE_RETURN = 0x0d;
const CSI = 0x5b;
const SAVE_CURSOR = 0x73;
const RESTORE_CURSOR = 0x75;
const DEC_SAVE_CURSOR = 0x37;
const DEC_RESTORE_CURSOR = 0x38;
const ERASE_LINE = 0x4b;
const ERASE_DISPLAY = 0x4a;
const CURSOR_POSITION = 0x48;
const HORIZONTAL_VERTICAL_POSITION = 0x66;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const SEMICOLON = 0x3b;
const QUESTION_MARK = 0x3f;
const CONTROL_SEQUENCE_FINAL_MIN = 0x40;
const CONTROL_SEQUENCE_FINAL_MAX = 0x7e;

interface TerminalRedrawControlScanResult {
  containsRedrawControlSequence: boolean;
  trailingEscapeSequence: Uint8Array | null;
}

export interface TerminalRedrawControlTracker {
  isRedrawControlChunk: (chunk: Uint8Array) => boolean;
  reset: () => void;
}

function isDigit(byte: number): boolean {
  return byte >= DIGIT_ZERO && byte <= DIGIT_NINE;
}

function isControlSequenceFinal(byte: number): boolean {
  return byte >= CONTROL_SEQUENCE_FINAL_MIN && byte <= CONTROL_SEQUENCE_FINAL_MAX;
}

function concatenateChunks(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function scanTerminalRedrawControlSequence(chunk: Uint8Array): TerminalRedrawControlScanResult {
  for (let index = 0; index < chunk.length; index += 1) {
    const byte = chunk[index];
    if (byte === CARRIAGE_RETURN) {
      return {
        containsRedrawControlSequence: true,
        trailingEscapeSequence: null,
      };
    }

    if (byte !== ESCAPE) {
      continue;
    }

    if (index === chunk.length - 1) {
      return {
        containsRedrawControlSequence: false,
        trailingEscapeSequence: chunk.subarray(index),
      };
    }

    const next = chunk[index + 1];
    if (next === DEC_SAVE_CURSOR || next === DEC_RESTORE_CURSOR) {
      return {
        containsRedrawControlSequence: true,
        trailingEscapeSequence: null,
      };
    }

    if (next !== CSI) {
      continue;
    }

    if (index + 2 >= chunk.length) {
      return {
        containsRedrawControlSequence: false,
        trailingEscapeSequence: chunk.subarray(index),
      };
    }

    for (let cursor = index + 2; cursor < chunk.length; cursor += 1) {
      const controlByte = chunk[cursor];
      if (controlByte === undefined) {
        break;
      }
      if (isDigit(controlByte) || controlByte === SEMICOLON || controlByte === QUESTION_MARK) {
        continue;
      }

      if (
        controlByte === ERASE_LINE ||
        controlByte === ERASE_DISPLAY ||
        controlByte === CURSOR_POSITION ||
        controlByte === HORIZONTAL_VERTICAL_POSITION ||
        controlByte === SAVE_CURSOR ||
        controlByte === RESTORE_CURSOR
      ) {
        return {
          containsRedrawControlSequence: true,
          trailingEscapeSequence: null,
        };
      }

      if (isControlSequenceFinal(controlByte)) {
        break;
      }

      break;
    }

    const lastByte = chunk[chunk.length - 1];
    if (
      lastByte !== undefined &&
      (isDigit(lastByte) || lastByte === SEMICOLON || lastByte === QUESTION_MARK)
    ) {
      return {
        containsRedrawControlSequence: false,
        trailingEscapeSequence: chunk.subarray(index),
      };
    }
  }

  return {
    containsRedrawControlSequence: false,
    trailingEscapeSequence: null,
  };
}

export function containsTerminalRedrawControlSequence(chunk: Uint8Array): boolean {
  return scanTerminalRedrawControlSequence(chunk).containsRedrawControlSequence;
}

export function createTerminalRedrawControlTracker(): TerminalRedrawControlTracker {
  let trailingEscapeSequence: Uint8Array | null = null;

  function isRedrawControlChunk(chunk: Uint8Array): boolean {
    const combinedChunk = trailingEscapeSequence
      ? concatenateChunks(trailingEscapeSequence, chunk)
      : chunk;
    const scanResult = scanTerminalRedrawControlSequence(combinedChunk);
    trailingEscapeSequence = scanResult.trailingEscapeSequence;
    return scanResult.containsRedrawControlSequence || trailingEscapeSequence !== null;
  }

  function reset(): void {
    trailingEscapeSequence = null;
  }

  return {
    isRedrawControlChunk,
    reset,
  };
}
