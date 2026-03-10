import { describe, it, expect } from 'vitest';
import { parsePermissionPrompt, PermissionBuffer } from './permissionParser';

describe('parsePermissionPrompt', () => {
  it('detects Claude Code edit permission prompt', () => {
    const text = `
      Tool: Edit
      File: src/app.ts
      Do you want to allow this action? (y/n)
    `;
    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('Edit');
    expect(result?.arguments).toBe('src/app.ts');
  });

  it('detects Claude Code bash permission prompt', () => {
    const text = `
      Tool: Bash
      Command: npm install lodash
      Do you want to run this command? (y/n)
    `;
    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('Bash');
    expect(result?.arguments).toBe('npm install lodash');
  });

  it('detects "Allow tool" style prompt', () => {
    const text = 'Allow tool: Write\nPath: /tmp/foo.txt\n[Y/n]';
    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('Write');
  });

  it('returns null for non-permission output', () => {
    const text = 'Building project...\nCompilation successful.';
    expect(parsePermissionPrompt(text)).toBeNull();
  });

  it('returns null when there is a permission keyword but no approve/deny prompt', () => {
    const text = 'Permission requested but no action choices shown';
    expect(parsePermissionPrompt(text)).toBeNull();
  });

  it('extracts description from the prompt line', () => {
    const text = 'Do you want to allow Edit on src/main.ts?\nTool: Edit\nFile: src/main.ts\n(y/n)';
    const result = parsePermissionPrompt(text);
    expect(result).not.toBeNull();
    expect(result?.description).toContain('Do you want to allow');
  });
});

describe('PermissionBuffer', () => {
  it('returns null for partial output', () => {
    const buf = new PermissionBuffer();
    expect(buf.feed('Tool: Edit\n')).toBeNull();
    expect(buf.feed('File: src/app.ts\n')).toBeNull();
  });

  it('returns permission when prompt is complete', () => {
    const buf = new PermissionBuffer();
    buf.feed('Tool: Edit\n');
    buf.feed('File: src/app.ts\n');
    const result = buf.feed('Do you want to allow this? (y/n)');
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('Edit');
  });

  it('resets after a successful parse', () => {
    const buf = new PermissionBuffer();
    buf.feed('Tool: Edit\nFile: src/app.ts\nDo you want to allow this? (y/n)');
    expect(buf.feed('some other output')).toBeNull();
  });

  it('handles buffer overflow gracefully', () => {
    const buf = new PermissionBuffer();
    for (let i = 0; i < 100; i++) {
      buf.feed('x'.repeat(100));
    }
    const result = buf.feed('Tool: Bash\nCommand: ls\nDo you want to run this? (y/n)');
    expect(result).not.toBeNull();
  });
});
