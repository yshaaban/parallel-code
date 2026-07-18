const ESCAPE = 0x1b;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;
const CSI = 0x5b;
const SAVE_CURSOR = 0x73;
const RESTORE_CURSOR = 0x75;
const DEC_SAVE_CURSOR = 0x37;
const DEC_RESTORE_CURSOR = 0x38;
const ERASE_LINE = 0x4b;
const ERASE_DISPLAY = 0x4a;
const CURSOR_POSITION = 0x48;
const HORIZONTAL_VERTICAL_POSITION = 0x66;
const CONTROL_SEQUENCE_INTERMEDIATE_MIN = 0x20;
const CONTROL_SEQUENCE_INTERMEDIATE_MAX = 0x2f;
const CONTROL_SEQUENCE_PARAMETER_MIN = 0x30;
const CONTROL_SEQUENCE_PARAMETER_MAX = 0x3f;
const CONTROL_SEQUENCE_FINAL_MIN = 0x40;
const CONTROL_SEQUENCE_FINAL_MAX = 0x7e;
const CANCEL = 0x18;
const SUBSTITUTE = 0x1a;
const C0_CONTROL_MAX = 0x1f;
const DELETE = 0x7f;

type TerminalControlSequenceState = 'csi' | 'escape' | 'ground';

export interface TerminalRedrawControlTracker {
  analyzeChunk: (chunk: Uint8Array) => TerminalRedrawControlAnalysis;
  isRedrawControlChunk: (chunk: Uint8Array) => boolean;
  reset: () => void;
}

export interface TerminalRedrawControlAnalysis {
  carriageReturnCount: number;
  clearDisplayCount: number;
  clearLineCount: number;
  containsControlSequence: boolean;
  containsRedrawControlSequence: boolean;
  cursorPositionCount: number;
  hasPendingControlSequence: boolean;
  pendingCarriageReturnCount: number;
  saveRestoreCount: number;
}

interface TerminalRedrawControlScanResult extends TerminalRedrawControlAnalysis {
  nextControlSequenceState: TerminalControlSequenceState;
}

function isControlSequenceFinal(byte: number): boolean {
  return byte >= CONTROL_SEQUENCE_FINAL_MIN && byte <= CONTROL_SEQUENCE_FINAL_MAX;
}

function isControlSequencePrefixByte(byte: number): boolean {
  return (
    (byte >= CONTROL_SEQUENCE_INTERMEDIATE_MIN && byte <= CONTROL_SEQUENCE_INTERMEDIATE_MAX) ||
    (byte >= CONTROL_SEQUENCE_PARAMETER_MIN && byte <= CONTROL_SEQUENCE_PARAMETER_MAX)
  );
}

function scanTerminalRedrawControlSequence(
  chunk: Uint8Array,
  initialControlSequenceState: TerminalControlSequenceState = 'ground',
  initialPendingCarriageReturnCount = 0,
): TerminalRedrawControlScanResult {
  let carriageReturnCount = 0;
  let clearDisplayCount = 0;
  let clearLineCount = 0;
  let containsControlSequence = initialControlSequenceState !== 'ground';
  let controlSequenceState = initialControlSequenceState;
  let cursorPositionCount = 0;
  let pendingCarriageReturnCount = initialPendingCarriageReturnCount;
  let saveRestoreCount = 0;

  for (const byte of chunk) {
    if (pendingCarriageReturnCount > 0) {
      if (byte === CARRIAGE_RETURN) {
        pendingCarriageReturnCount += 1;
        continue;
      }
      if (byte === LINE_FEED) {
        pendingCarriageReturnCount = 0;
        continue;
      }

      carriageReturnCount += pendingCarriageReturnCount;
      pendingCarriageReturnCount = 0;
    }

    if (byte === CARRIAGE_RETURN) {
      pendingCarriageReturnCount = 1;
      continue;
    }

    if (byte === ESCAPE) {
      containsControlSequence = true;
      controlSequenceState = 'escape';
      continue;
    }

    if (controlSequenceState === 'ground') {
      continue;
    }

    containsControlSequence = true;
    if (byte === CANCEL || byte === SUBSTITUTE) {
      controlSequenceState = 'ground';
      continue;
    }
    if (byte <= C0_CONTROL_MAX || byte === DELETE) {
      continue;
    }

    if (controlSequenceState === 'escape') {
      if (byte === CSI) {
        controlSequenceState = 'csi';
        continue;
      }

      if (byte === DEC_SAVE_CURSOR || byte === DEC_RESTORE_CURSOR) {
        saveRestoreCount += 1;
      }
      controlSequenceState = 'ground';
      continue;
    }

    if (isControlSequencePrefixByte(byte)) {
      continue;
    }

    controlSequenceState = 'ground';
    if (!isControlSequenceFinal(byte)) {
      continue;
    }

    if (byte === ERASE_LINE) {
      clearLineCount += 1;
    } else if (byte === ERASE_DISPLAY) {
      clearDisplayCount += 1;
    } else if (byte === CURSOR_POSITION || byte === HORIZONTAL_VERTICAL_POSITION) {
      cursorPositionCount += 1;
    } else if (byte === SAVE_CURSOR || byte === RESTORE_CURSOR) {
      saveRestoreCount += 1;
    }
  }

  const containsRedrawControlSequence =
    carriageReturnCount > 0 ||
    clearDisplayCount > 0 ||
    clearLineCount > 0 ||
    cursorPositionCount > 0 ||
    saveRestoreCount > 0;

  return {
    carriageReturnCount,
    clearDisplayCount,
    clearLineCount,
    containsControlSequence,
    containsRedrawControlSequence,
    cursorPositionCount,
    hasPendingControlSequence: controlSequenceState !== 'ground',
    nextControlSequenceState: controlSequenceState,
    pendingCarriageReturnCount,
    saveRestoreCount,
  };
}

export function containsTerminalRedrawControlSequence(chunk: Uint8Array): boolean {
  const result = scanTerminalRedrawControlSequence(chunk);
  return result.containsRedrawControlSequence || result.pendingCarriageReturnCount > 0;
}

export function createTerminalRedrawControlTracker(): TerminalRedrawControlTracker {
  let controlSequenceState: TerminalControlSequenceState = 'ground';
  let pendingCarriageReturnCount = 0;

  function analyzeChunk(chunk: Uint8Array): TerminalRedrawControlAnalysis {
    const result = scanTerminalRedrawControlSequence(
      chunk,
      controlSequenceState,
      pendingCarriageReturnCount,
    );
    controlSequenceState = result.nextControlSequenceState;
    pendingCarriageReturnCount = result.pendingCarriageReturnCount;
    return result;
  }

  function isRedrawControlChunk(chunk: Uint8Array): boolean {
    const result = analyzeChunk(chunk);
    return result.containsRedrawControlSequence || result.hasPendingControlSequence;
  }

  function reset(): void {
    controlSequenceState = 'ground';
    pendingCarriageReturnCount = 0;
  }

  return {
    analyzeChunk,
    isRedrawControlChunk,
    reset,
  };
}
