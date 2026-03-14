import { describe, expect, it } from 'vitest';

import { parseMultiFileUnifiedDiff } from './unified-diff-parser';

describe('parseMultiFileUnifiedDiff', () => {
  it('returns an empty list for empty input', () => {
    expect(parseMultiFileUnifiedDiff('')).toEqual([]);
  });

  it('parses modified and added files', () => {
    const parsed = parseMultiFileUnifiedDiff(`diff --git a/src/file.ts b/src/file.ts
index 1111111..2222222 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,2 +1,3 @@
 line one
-line two
+line two changed
+line three
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+alpha
+beta
`);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      path: 'src/file.ts',
      status: 'M',
      binary: false,
    });
    expect(parsed[0]?.hunks[0]?.lines).toHaveLength(4);
    expect(parsed[1]).toMatchObject({
      path: 'src/new.ts',
      status: 'A',
      binary: false,
    });
  });

  it('marks binary file blocks as binary', () => {
    const parsed = parseMultiFileUnifiedDiff(`diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
Binary files /dev/null and b/assets/logo.png differ
`);

    expect(parsed).toEqual([
      {
        path: 'assets/logo.png',
        status: 'A',
        binary: true,
        hunks: [],
      },
    ]);
  });
});
