const ESC = '\x1b';

function padTo(text, width) {
  const clipped = text.slice(0, width);
  return `${clipped}${' '.repeat(Math.max(0, width - clipped.length))}`;
}

function moveTo(row, column) {
  return `${ESC}[${row};${column}H`;
}

function clearLine() {
  return `${ESC}[2K`;
}

function splitTextRun(text, chunks) {
  const sizes = [17, 5, 29, 3, 11, 7, 23];
  let offset = 0;
  let sizeIndex = 0;

  while (offset < text.length) {
    const size = sizes[sizeIndex % sizes.length];
    chunks.push(text.slice(offset, offset + size));
    offset += size;
    sizeIndex += 1;
  }
}

export function splitAnsiStressChunks(data) {
  const chunks = [];
  let offset = 0;

  while (offset < data.length) {
    const escapeIndex = data.indexOf(ESC, offset);
    if (escapeIndex === -1) {
      splitTextRun(data.slice(offset), chunks);
      break;
    }

    if (escapeIndex > offset) {
      splitTextRun(data.slice(offset, escapeIndex), chunks);
    }

    chunks.push(ESC);
    offset = escapeIndex + 1;
    if (offset < data.length) {
      chunks.push(data[offset]);
      offset += 1;
    }
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

export function buildCursorAddressedRedrawFixture({ cols = 96, frames = 18, rows = 32 } = {}) {
  const promptRow = Math.max(4, Math.floor(rows * 0.58));
  const promptColumn = 8;
  const cursorColumn = promptColumn + 'input> '.length;
  const statusRow = Math.max(2, rows - 2);
  const footerRow = rows;
  const sections = [];

  for (let line = 0; line < rows + 8; line += 1) {
    sections.push(`history ${String(line + 1).padStart(3, '0')} before redraw\r\n`);
  }

  sections.push(`${ESC}[?25l${ESC}[H${ESC}[2J`);
  sections.push(`${moveTo(1, 1)}${padTo('cursor-addressed redraw fixture', cols)}`);
  sections.push(`${moveTo(statusRow, 1)}${padTo('status: booting', cols)}`);
  sections.push(`${moveTo(promptRow, promptColumn)}input>`);

  for (let frame = 0; frame < frames; frame += 1) {
    const marker = `cursor-target-${String(frame).padStart(3, '0')}`;
    sections.push(
      [
        `${ESC}[s`,
        `${moveTo(2, 1)}${clearLine()}frame ${String(frame).padStart(3, '0')}`,
        `${moveTo(statusRow, 1)}${clearLine()}${padTo(`status: redraw ${frame}`, cols)}`,
        `${moveTo(promptRow, promptColumn)}${clearLine()}${padTo(`input> ${marker}`, cols)}`,
        `${moveTo(footerRow, 1)}${clearLine()}footer stays below cursor target`,
        `${ESC}[u`,
      ].join(''),
    );
  }

  sections.push(`${ESC}[?25h${moveTo(promptRow, cursorColumn)}`);

  return {
    chunks: splitAnsiStressChunks(sections.join('')),
    expectedCursor: {
      x: cursorColumn - 1,
      y: promptRow - 1,
    },
    expectedPromptText: `input> cursor-target-${String(frames - 1).padStart(3, '0')}`,
    initialCols: cols,
    initialRows: rows,
    promptRow,
  };
}

export function buildAlternateScreenFixture({ cols = 84, frames = 12, rows = 26 } = {}) {
  const promptRow = Math.max(5, Math.floor(rows / 2));
  const promptColumn = 6;
  const cursorColumn = promptColumn + 'choice:'.length + 1;
  const statusRow = rows - 1;
  const sections = [
    `${ESC}[?1049h${ESC}[?25l${ESC}[H${ESC}[2J`,
    `${moveTo(1, 1)}${padTo('alternate-screen redraw fixture', cols)}`,
  ];

  for (let frame = 0; frame < frames; frame += 1) {
    sections.push(
      [
        `${moveTo(3, 4)}${clearLine()}panel frame ${String(frame).padStart(3, '0')}`,
        `${moveTo(promptRow, promptColumn)}${clearLine()}${padTo(`choice: option-${frame}`, cols - promptColumn)}`,
        `${moveTo(statusRow, 2)}${clearLine()}alt-screen status ${frame}`,
      ].join(''),
    );
  }

  sections.push(`${ESC}[?25h${moveTo(promptRow, cursorColumn)}`);

  return {
    chunks: splitAnsiStressChunks(sections.join('')),
    expectedCursor: {
      x: cursorColumn - 1,
      y: promptRow - 1,
    },
    expectedPromptText: `choice: option-${frames - 1}`,
    initialCols: cols,
    initialRows: rows,
    promptRow,
  };
}

export function buildResizeStormFixture({ initialCols = 88, initialRows = 24, frames = 20 } = {}) {
  const sizes = [
    { cols: 72, rows: 18 },
    { cols: 104, rows: 30 },
    { cols: 90, rows: 21 },
    { cols: 118, rows: 28 },
    { cols: 96, rows: 26 },
  ];
  const steps = [];

  steps.push({
    data: `${ESC}[?25l${ESC}[H${ESC}[2J${moveTo(1, 1)}resize storm fixture`,
    kind: 'write',
  });

  for (let frame = 0; frame < frames; frame += 1) {
    const size = sizes[frame % sizes.length];
    const promptRow = Math.max(4, Math.floor(size.rows / 2));
    const promptColumn = 7;
    steps.push({ cols: size.cols, kind: 'resize', rows: size.rows });
    steps.push({
      data: [
        `${moveTo(1, 1)}${clearLine()}resize storm fixture ${size.cols}x${size.rows}`,
        `${moveTo(2, 1)}${clearLine()}frame ${String(frame).padStart(3, '0')}`,
        `${moveTo(promptRow, promptColumn)}${clearLine()}${padTo(`input> resize-${String(frame).padStart(3, '0')}`, size.cols - promptColumn)}`,
      ].join(''),
      kind: 'write',
    });
  }

  const finalSize = sizes[(frames - 1) % sizes.length];
  const promptRow = Math.max(4, Math.floor(finalSize.rows / 2));
  const promptColumn = 7;
  const cursorColumn = promptColumn + 'input> '.length;
  steps.push({
    data: `${ESC}[?25h${moveTo(promptRow, cursorColumn)}`,
    kind: 'write',
  });

  return {
    expectedCursor: {
      x: cursorColumn - 1,
      y: promptRow - 1,
    },
    expectedPromptText: `input> resize-${String(frames - 1).padStart(3, '0')}`,
    finalCols: finalSize.cols,
    finalRows: finalSize.rows,
    initialCols,
    initialRows,
    promptRow,
    steps: steps.map((step) =>
      step.kind === 'write' ? { chunks: splitAnsiStressChunks(step.data), kind: 'write' } : step,
    ),
  };
}
