import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nContext';

interface CopyButtonProps {
  /** 要复制的文本 */
  text: string;
  /** 按钮文字 */
  label: string;
}

export default function CopyButton({ text, label }: CopyButtonProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（如非安全上下文），静默忽略
    }
  };

  return (
    <button type="button" className="btn-copy" onClick={() => void handleCopy()}>
      {copied ? t('copyButton.copied') : label}
    </button>
  );
}
