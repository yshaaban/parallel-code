import { describe, expect, it } from 'vitest';

import { computeTerminalMarkdownLinks } from './terminal-links.js';

interface CellSpec {
  chars: string;
  width: number;
}

function cellsForText(text: string): CellSpec[] {
  return [...text].flatMap((chars) => {
    const width = chars === '界' ? 2 : 1;
    return width === 2
      ? [
          { chars, width },
          { chars: '', width: 0 },
        ]
      : [{ chars, width }];
  });
}

function createBuffer(
  rows: Array<{ cells?: CellSpec[]; isWrapped?: boolean; text: string }>,
): Parameters<typeof computeTerminalMarkdownLinks>[0] {
  return {
    getLine(index: number) {
      const row = rows[index];
      if (!row) {
        return undefined;
      }
      const cells = row.cells ?? cellsForText(row.text);
      return {
        getCell(column: number) {
          const cell = cells[column];
          return cell
            ? {
                getChars: () => cell.chars,
                getCode: () => 0,
                getWidth: () => cell.width,
              }
            : undefined;
        },
        isWrapped: row.isWrapped === true,
        length: cells.length,
        translateToString: () => row.text,
      };
    },
    getNullCell() {
      return {
        getChars: () => '',
        getCode: () => 0,
        getWidth: () => 1,
      };
    },
    length: rows.length,
  } as Parameters<typeof computeTerminalMarkdownLinks>[0];
}

describe('computeTerminalMarkdownLinks', () => {
  it('returns the same multi-row range from every contributing wrapped row', () => {
    const buffer = createBuffer([
      { text: '/tmp/project/docs/ver' },
      { isWrapped: true, text: 'y-long.md' },
    ]);

    const expected = [
      {
        range: { end: { x: 9, y: 2 }, start: { x: 1, y: 1 } },
        relativePath: 'docs/very-long.md',
        text: '/tmp/project/docs/very-long.md',
      },
    ];
    expect(computeTerminalMarkdownLinks(buffer, 1, '/tmp/project')).toEqual(expected);
    expect(computeTerminalMarkdownLinks(buffer, 2, '/tmp/project')).toEqual(expected);
  });

  it('maps wide and combined cells without treating UTF-16 offsets as columns', () => {
    const combined = 'e\u0301';
    const firstText = `/tmp/project/${combined}/界`;
    const firstCells = [
      ...cellsForText('/tmp/project/'),
      { chars: combined, width: 1 },
      ...cellsForText('/界'),
      { chars: '', width: 1 },
    ];
    const buffer = createBuffer([
      { cells: firstCells, text: firstText },
      { isWrapped: true, text: '/guide.md' },
    ]);

    expect(computeTerminalMarkdownLinks(buffer, 2, '/tmp/project')).toEqual([
      {
        range: { end: { x: 9, y: 2 }, start: { x: 1, y: 1 } },
        relativePath: `${combined}/界/guide.md`,
        text: `${firstText}/guide.md`,
      },
    ]);
  });

  it('handles a phantom wrap cell before a width-two glyph on the continuation row', () => {
    const firstText = '/tmp/project/docs/';
    const buffer = createBuffer([
      {
        cells: [...cellsForText(firstText), { chars: '', width: 1 }],
        text: firstText,
      },
      { isWrapped: true, text: '界/guide.md' },
    ]);

    expect(computeTerminalMarkdownLinks(buffer, 1, '/tmp/project')).toEqual([
      {
        range: { end: { x: 11, y: 2 }, start: { x: 1, y: 1 } },
        relativePath: 'docs/界/guide.md',
        text: '/tmp/project/docs/界/guide.md',
      },
    ]);
  });

  it('does not join hard-newline-separated path fragments', () => {
    const buffer = createBuffer([{ text: '/tmp/project/docs/' }, { text: 'guide.md' }]);

    expect(computeTerminalMarkdownLinks(buffer, 1, '/tmp/project')).toEqual([]);
    expect(computeTerminalMarkdownLinks(buffer, 2, '/tmp/project')).toEqual([
      {
        range: { end: { x: 8, y: 2 }, start: { x: 1, y: 2 } },
        relativePath: 'guide.md',
        text: 'guide.md',
      },
    ]);
  });

  it('finds multiple links and strips location, query, fragment, and punctuation suffixes', () => {
    const text = 'docs/a.md:12:4 and (file:///tmp/project/docs/b.md?raw=1#title).';
    const buffer = createBuffer([{ text }]);

    expect(computeTerminalMarkdownLinks(buffer, 1, '/tmp/project')).toMatchObject([
      { relativePath: 'docs/a.md', text: 'docs/a.md' },
      { relativePath: 'docs/b.md', text: 'file:///tmp/project/docs/b.md' },
    ]);
  });

  it('fails closed when either logical-line scan bound would be truncated', () => {
    const rows = [
      { text: '/tmp/project/docs/' },
      { isWrapped: true, text: 'very-' },
      { isWrapped: true, text: 'long.md' },
    ];
    const buffer = createBuffer(rows);

    expect(
      computeTerminalMarkdownLinks(buffer, 2, '/tmp/project', { maxCells: 100, maxRows: 2 }),
    ).toEqual([]);
    expect(
      computeTerminalMarkdownLinks(buffer, 2, '/tmp/project', { maxCells: 10, maxRows: 3 }),
    ).toEqual([]);
  });

  it('rejects invalid rows, traversal, root equality, home shortcuts, and outside roots', () => {
    const buffer = createBuffer([
      { text: '../outside.md /tmp/project.md ~/notes.md /tmp/other/no.md' },
    ]);
    expect(computeTerminalMarkdownLinks(buffer, 0, '/tmp/project')).toEqual([]);
    expect(computeTerminalMarkdownLinks(buffer, 1, '/tmp/project')).toEqual([]);
  });

  it.each([
    'docs/foo%2F..%2F..%2Foutside.md',
    'file:///tmp/project/foo%2F..%2F..%2Foutside.md',
    'docs/%2e%2e/outside.md',
  ])('rejects encoded POSIX path structure in %s', (pathText) => {
    expect(
      computeTerminalMarkdownLinks(createBuffer([{ text: pathText }]), 1, '/tmp/project'),
    ).toEqual([]);
  });

  it.each(['docs%5C..%5Coutside.md', 'file:///C:/project/docs%5C..%5Coutside.md'])(
    'rejects encoded Windows separators in %s',
    (pathText) => {
      expect(
        computeTerminalMarkdownLinks(createBuffer([{ text: pathText }]), 1, 'C:\\project'),
      ).toEqual([]);
    },
  );

  it('preserves benign percent-encoded path segments', () => {
    const text = 'file:///tmp/project/docs/My%20Guide.md';

    expect(computeTerminalMarkdownLinks(createBuffer([{ text }]), 1, '/tmp/project')).toEqual([
      {
        range: { end: { x: text.length, y: 1 }, start: { x: 1, y: 1 } },
        relativePath: 'docs/My Guide.md',
        text,
      },
    ]);
  });

  it('fails closed for malformed or adversarial buffer implementations', () => {
    const missingContinuation = createBuffer([
      { text: '/tmp/project/docs/' },
      { isWrapped: true, text: 'guide.md' },
    ]);
    const originalGetLine = missingContinuation.getLine.bind(missingContinuation);
    missingContinuation.getLine = (index: number) =>
      index === 1 ? undefined : originalGetLine(index);

    expect(computeTerminalMarkdownLinks(missingContinuation, 1, '/tmp/project')).toEqual([]);

    const throwingBuffer = {
      get length() {
        return 1;
      },
      getLine() {
        throw new Error('disposed buffer');
      },
      getNullCell() {
        throw new Error('disposed buffer');
      },
    } as Parameters<typeof computeTerminalMarkdownLinks>[0];
    expect(computeTerminalMarkdownLinks(throwingBuffer, 1, '/tmp/project')).toEqual([]);

    const invalidWidthBuffer = createBuffer([
      {
        cells: [{ chars: '/tmp/project/docs/guide.md', width: 3 }],
        text: '/tmp/project/docs/guide.md',
      },
    ]);
    expect(computeTerminalMarkdownLinks(invalidWidthBuffer, 1, '/tmp/project')).toEqual([]);
  });

  it('validates scan limits before touching the buffer', () => {
    let reads = 0;
    const buffer = {
      getLine() {
        reads += 1;
        return undefined;
      },
      getNullCell() {
        reads += 1;
        return undefined;
      },
      length: 1,
    } as unknown as Parameters<typeof computeTerminalMarkdownLinks>[0];

    expect(computeTerminalMarkdownLinks(buffer, 1.5, '/tmp/project')).toEqual([]);
    expect(
      computeTerminalMarkdownLinks(buffer, 1, '/tmp/project', { maxCells: 0, maxRows: 1 }),
    ).toEqual([]);
    expect(
      computeTerminalMarkdownLinks(buffer, 1, '/tmp/project', {
        maxCells: Number.MAX_SAFE_INTEGER + 1,
        maxRows: 1,
      }),
    ).toEqual([]);
    expect(reads).toBe(0);
  });
});
