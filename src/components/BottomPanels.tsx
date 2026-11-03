import { useState } from 'react';
import { AlertTriangle, CircleAlert, Info, OctagonAlert } from 'lucide-react';
import type { Warning } from '../lib/cvm/interp';

interface Props {
  output: string;
  warnings: Warning[];
  onJumpLine?: (line: number) => void;
  compileError?: string | null;
}

const ICONS = {
  leak: <OctagonAlert size={14} className="mt-0.5 flex-none" />,
  error: <CircleAlert size={14} className="mt-0.5 flex-none" />,
  warn: <AlertTriangle size={14} className="mt-0.5 flex-none" />,
  info: <Info size={14} className="mt-0.5 flex-none" />,
} as const;

export function BottomPanels({ output, warnings, onJumpLine, compileError }: Props) {
  const [tab, setTab] = useState<'out' | 'warn'>('out');
  const badCount = warnings.filter((w) => w.level === 'leak' || w.level === 'error').length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex border-b border-[var(--line)]" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'out'}
          className="mtab !h-10 flex-none px-4"
          data-active={tab === 'out'}
          onClick={() => setTab('out')}
        >
          输出
        </button>
        <button
          role="tab"
          aria-selected={tab === 'warn'}
          className="mtab !h-10 flex-none px-4"
          data-active={tab === 'warn'}
          onClick={() => setTab('warn')}
        >
          警告
          {badCount > 0 && (
            <span className="rounded-full bg-[var(--c-danger)] px-1.5 text-[10px] font-bold text-[oklch(0.2_0.03_25)]">
              {badCount}
            </span>
          )}
        </button>
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-auto p-3">
        {tab === 'out' ? (
          compileError ? (
            <div className="warn-item warn-error">
              {ICONS.error}
              <span>{compileError}</span>
            </div>
          ) : output ? (
            <pre className="term-out code-font text-[13px]">{output}</pre>
          ) : (
            <p className="text-[12px] text-[var(--faint)]">（暂无输出，printf 的内容会显示在这里）</p>
          )
        ) : (
          <div>
            {compileError && (
              <div className="warn-item warn-error">
                {ICONS.error}
                <span>{compileError}</span>
              </div>
            )}
            {warnings.length === 0 && !compileError && (
              <p className="text-[12px] text-[var(--faint)]">
                （暂无警告。泄漏、越界、重复释放等问题会在这里提醒）
              </p>
            )}
            {warnings.map((w) => (
              <div key={w.id} className={`warn-item warn-${w.level}`}>
                {ICONS[w.level]}
                <span className="flex-1">{w.message}</span>
                {w.line !== undefined && onJumpLine && (
                  <button
                    className="flex-none underline underline-offset-2 opacity-70 transition-opacity hover:opacity-100"
                    onClick={() => onJumpLine(w.line!)}
                  >
                    L{w.line}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
