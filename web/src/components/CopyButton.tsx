import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';

interface CopyButtonProps {
  /** 要复制的文本 */
  text: string;
  /** 按钮文字 */
  label: string;
  className?: string;
}

export async function copyTextToClipboard(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
  documentRef: Document | undefined = globalThis.document,
): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Some embedded browsers expose the async API but reject it at runtime.
    }
  }

  if (!documentRef?.body || typeof documentRef.execCommand !== 'function') return false;
  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  documentRef.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return documentRef.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

export default function CopyButton({ text, label, className = 'btn secondary small' }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (await copyTextToClipboard(text)) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button type="button" className={className} onClick={() => void handleCopy()}>
      {copied ? t('copyButton.copied') : label}
    </button>
  );
}
