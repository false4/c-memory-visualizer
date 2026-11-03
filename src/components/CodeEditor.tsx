import { useEffect, useRef } from 'react';

interface Props {
  code: string;
  onChange?: (code: string) => void;
  mode: 'edit' | 'run';
  currentLine: number;
  errorLine?: number;
  note?: string;
}

/** 代码编辑 / 单步高亮查看 */
export function CodeEditor({ code, onChange, mode, currentLine, errorLine, note }: Props) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const lines = code.split('\n');

  useEffect(() => {
    if (mode === 'run' && viewRef.current && currentLine > 0) {
      const el = viewRef.current.children[currentLine - 1] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentLine, mode]);

  const syncScroll = () => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* 行号 */}
      <div
        ref={gutterRef}
        className="code-font thin-scroll overflow-hidden border-r border-[var(--line)] pt-3"
        aria-hidden
      >
        {lines.map((_, i) => (
          <div key={i} className="gutter-num code-line">
            {i + 1}
          </div>
        ))}
        <div className="h-3" />
      </div>

      {mode === 'edit' ? (
        <textarea
          ref={taRef}
          className="code-font code-textarea thin-scroll flex-1 p-3 pl-3"
          value={code}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="C 代码编辑器"
        />
      ) : (
        <div ref={viewRef} className="code-font thin-scroll flex-1 overflow-auto pt-3">
          {lines.map((ln, i) => {
            const n = i + 1;
            const cls =
              n === errorLine
                ? 'code-line-error'
                : n === currentLine
                  ? 'code-line-current'
                  : '';
            return (
              <div key={i} className={`code-line flex ${cls}`}>
                <span className="w-5 flex-none text-center text-[11px] leading-[22px] text-[var(--accent)]">
                  {n === currentLine ? '▸' : ''}
                </span>
                <span className="text-[var(--text)]">{ln || ' '}</span>
              </div>
            );
          })}
          <div className="h-3" />
        </div>
      )}

      {mode === 'run' && note && (
        <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-[var(--line)] bg-[var(--panel-2)] px-2 py-1 text-[11px] text-[var(--muted)]">
          {note}
        </div>
      )}
    </div>
  );
}
