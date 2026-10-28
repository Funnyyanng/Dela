import { describe, expect, it } from 'vitest';
import { relocateWorkspacePath, workspacePathAffected } from './workspace';

describe('workspacePathAffected', () => {
  it('只匹配变更文件本身或无文件名通知的目录根，不匹配同前缀路径', () => {
    expect(workspacePathAffected('/courses/a/note.md', '/courses/a/note.md')).toBe(true);
    expect(workspacePathAffected('/courses/a/note.md', '/courses/a/')).toBe(true);
    expect(workspacePathAffected('/courses/a/note.md', '/')).toBe(true);
    expect(workspacePathAffected('/courses/ab/note.md', '/courses/a')).toBe(false);
    expect(workspacePathAffected('/courses/a/note.md', '/courses/a/other.md')).toBe(false);
    expect(workspacePathAffected('/courses/A/note.md', '/courses/a/note.md')).toBe(false);
    expect(workspacePathAffected('/courses/a\\note.md', '/courses/a')).toBe(false);
  });

  it('Windows 路径兼容分隔符与大小写，UNC 路径同样匹配', () => {
    expect(workspacePathAffected('C:\\Courses\\note.md', 'c:/courses/NOTE.md')).toBe(true);
    expect(workspacePathAffected('\\\\server\\share\\note.md', '//server/share/')).toBe(true);
    expect(workspacePathAffected('C:/courses/other.md', 'C:\\courses\\note.md')).toBe(false);
  });
});

describe('relocateWorkspacePath', () => {
  it('移动 POSIX 子树时保留文件名中的反斜杠，不改同前缀的兄弟文件', () => {
    expect(relocateWorkspacePath('/repo/a/note\\draft.md', '/repo/a', '/repo/b')).toBe(
      '/repo/b/note\\draft.md',
    );
    for (const path of ['/repo/a\\note.md', '/repo/ab/note.md', '/repo/A/note.md'])
      expect(relocateWorkspacePath(path, '/repo/a', '/repo/b')).toBe(path);
  });

  it.each(['C:/repo/a', 'C:\\repo\\a', '\\\\server\\share\\a'])(
    'Windows 路径 %s 保留原有两种分隔符匹配',
    (from) => {
      const to = `${from}-renamed`;
      expect(relocateWorkspacePath(from, from, to)).toBe(to);
      for (const separator of ['/', '\\']) {
        const suffix = `${separator}notes${separator}draft.md`;
        expect(relocateWorkspacePath(`${from}${suffix}`, from, to)).toBe(`${to}${suffix}`);
      }
      expect(relocateWorkspacePath(`${from}-other/file.md`, from, to)).toBe(
        `${from}-other/file.md`,
      );
    },
  );

  it('POSIX 文件名本身含反斜杠时仍可精确重命名', () => {
    expect(relocateWorkspacePath('/repo/a\\note.md', '/repo/a\\note.md', '/repo/b.md')).toBe(
      '/repo/b.md',
    );
  });
});
