import { describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../src/components/CopyButton';

describe('copyTextToClipboard', () => {
  it('uses the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(copyTextToClipboard('guide', { writeText }, undefined)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('guide');
  });

  it('falls back to the legacy copy command when an embedded browser rejects clipboard access', async () => {
    const textarea = {
      value: '', style: {}, setAttribute: vi.fn(), focus: vi.fn(), select: vi.fn(), remove: vi.fn(),
    };
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(textarea),
      execCommand: vi.fn().mockReturnValue(true),
    } as unknown as Document;
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) };

    await expect(copyTextToClipboard('worker guide', clipboard, documentRef)).resolves.toBe(true);
    expect(textarea.value).toBe('worker guide');
    expect(documentRef.execCommand).toHaveBeenCalledWith('copy');
    expect(textarea.remove).toHaveBeenCalled();
  });
});
