import { useCallback, useEffect, useMemo, useState } from 'react';
import { Code2, Github, HelpCircle, MemoryStick, TerminalSquare, X } from 'lucide-react';
import { Simulator, LexError, ParseError, type RunResult } from './lib/cvm/interp';
import { SAMPLES } from './lib/cvm/samples';
import { CodeEditor } from './components/CodeEditor';
import { MemoryView } from './components/MemoryView';
import { ControlBar } from './components/ControlBar';
import { BottomPanels } from './components/BottomPanels';

const GITHUB_URL = 'https://github.com/false4/c-memory-visualizer';

type MobileTab = 'code' | 'mem' | 'io';

export default function App() {
  const [code, setCode] = useState(SAMPLES[0].code);
  const [sampleId, setSampleId] = useState(SAMPLES[0].id);
  const [run, setRun] = useState<RunResult | null>(null);
  const [runCode, setRunCode] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<number | undefined>(undefined);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [mode, setMode] = useState<'edit' | 'run'>('edit');
  const [showHelp, setShowHelp] = useState(false);
  const [mtab, setMtab] = useState<MobileTab>('code');

  const snapshots = useMemo(() => run?.snapshots ?? [], [run]);
  const snapshot = snapshots.length ? snapshots[Math.min(idx, snapshots.length - 1)] : null;
  const isFinal = snapshots.length > 0 && idx >= snapshots.length - 1;
  const dirty = runCode !== null && runCode !== code;

  const compile = useCallback((): RunResult | null => {
    try {
      const sim = new Simulator(code);
      const result = sim.runAll();
      setRun(result);
      setRunCode(code);
      setCompileError(null);
      setErrorLine(undefined);
      setMode('run');
      return result;
    } catch (e) {
      if (e instanceof ParseError || e instanceof LexError) {
        setCompileError(`语法错误：${e.message}`);
        setErrorLine(e.line);
      } else if (e instanceof Error) {
        setCompileError(e.message);
      }
      setRun(null);
      setRunCode(null);
      setMode('run');
      return null;
    }
  }, [code]);

  const togglePlay = useCallback(() => {
    if (!run) {
      const r = compile();
      if (r) {
        setIdx(0);
        setPlaying(true);
      }
      return;
    }
    if (isFinal) {
      setIdx(0);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }, [run, compile, isFinal]);

  const stepNext = useCallback(() => {
    if (!run) {
      const r = compile();
      if (r) setIdx((i) => Math.min(i + 1, r.snapshots.length - 1));
      setPlaying(false);
      return;
    }
    setPlaying(false);
    setIdx((i) => Math.min(i + 1, snapshots.length - 1));
  }, [run, compile, snapshots.length]);

  const stepPrev = useCallback(() => {
    setPlaying(false);
    setIdx((i) => Math.max(i - 1, 0));
  }, []);

  const reset = useCallback(() => {
    setPlaying(false);
    setIdx(0);
  }, []);

  // 自动播放
  useEffect(() => {
    if (!playing) return;
    if (idx >= snapshots.length - 1) {
      setPlaying(false);
      return;
    }
    const delay = 900 - speed * 80;
    const t = window.setTimeout(() => {
      setIdx((i) => Math.min(i + 1, snapshots.length - 1));
    }, delay);
    return () => window.clearTimeout(t);
  }, [playing, idx, speed, snapshots.length]);

  // 键盘快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== 'run') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, togglePlay, stepNext, stepPrev]);

  const jumpToLine = useCallback(
    (line: number) => {
      const i = snapshots.findIndex((s) => s.line === line);
      if (i >= 0) setIdx(i);
      setPlaying(false);
      setMtab('code');
    },
    [snapshots],
  );

  const pickSample = (id: string) => {
    const s = SAMPLES.find((x) => x.id === id);
    if (!s) return;
    setSampleId(id);
    setCode(s.code);
    // 立即用新代码重新运行
    try {
      const sim = new Simulator(s.code);
      const result = sim.runAll();
      setRun(result);
      setRunCode(s.code);
      setCompileError(null);
      setErrorLine(undefined);
    } catch {
      setRun(null);
      setRunCode(null);
    }
    setIdx(0);
    setPlaying(false);
    setMode('run');
  };

  const statusText = useMemo(() => {
    if (compileError) return '编译失败';
    if (!snapshot) return '';
    if (snapshot.state.status === 'error') return '运行出错';
    if (snapshot.state.status === 'done') return '程序结束';
    return snapshot.note ?? '运行中';
  }, [snapshot, compileError]);

  const editorPanel = (
    <div className="panel relative min-h-0 flex-1 overflow-hidden">
      <div className="panel-title justify-between">
        <span className="flex items-center gap-2">
          <Code2 size={13} className="text-[var(--accent)]" />
          main.c
        </span>
        {mode === 'run' ? (
          <button
            className="text-[11px] text-[var(--accent)] underline-offset-2 hover:underline"
            onClick={() => {
              setMode('edit');
              setPlaying(false);
            }}
          >
            编辑代码
          </button>
        ) : (
          <span className="text-[11px] text-[var(--faint)]">编辑后点击「运行」</span>
        )}
      </div>
      <div className="h-[calc(100%-37px)]">
        <CodeEditor
          code={code}
          onChange={setCode}
          mode={mode}
          currentLine={snapshot?.line ?? 0}
          errorLine={errorLine}
        />
      </div>
    </div>
  );

  const memoryPanel = (
    <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="panel-title justify-between">
        <span className="flex items-center gap-2">
          <MemoryStick size={13} className="text-[var(--accent)]" />
          内存分区
        </span>
        <span className="text-[10px] text-[var(--faint)]">块高度 ∝ 字节数</span>
      </div>
      {dirty && mode === 'run' && (
        <div className="border-b border-[var(--line)] bg-[color-mix(in_oklch,var(--c-heap)_10%,transparent)] px-3 py-1.5 text-[11px] text-[var(--c-heap)]">
          代码已修改 — 点击「运行」查看新的内存布局
        </div>
      )}
      <div className="min-h-0 flex-1">
        <MemoryView snapshot={snapshot} isFinal={isFinal} />
      </div>
    </div>
  );

  const ioPanel = (
    <div className="panel flex min-h-0 flex-col overflow-hidden">
      <BottomPanels
        output={snapshot?.state.output ?? ''}
        warnings={snapshot?.state.warnings ?? []}
        onJumpLine={jumpToLine}
        compileError={compileError}
      />
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)]">
      {/* 顶栏 */}
      <header className="flex h-14 flex-none items-center gap-3 border-b border-[var(--line)] bg-[var(--panel)] px-3 sm:px-4">
        <Logo />
        <div className="min-w-0">
          <h1 className="truncate text-[14px] font-semibold leading-tight text-[var(--text-strong)]">
            C 内存可视化
          </h1>
          <p className="hidden text-[10px] leading-tight text-[var(--faint)] sm:block">
            stack · heap · malloc / free
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={sampleId}
            onChange={(e) => pickSample(e.target.value)}
            className="h-9 max-w-[150px] cursor-pointer rounded-md border border-[var(--line)] bg-[var(--panel-2)] px-2 text-[12px] text-[var(--text)] outline-none transition-colors hover:border-[var(--accent)] sm:max-w-none"
            aria-label="选择示例代码"
          >
            {SAMPLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>

          <button className="tbtn" onClick={() => setShowHelp(true)} aria-label="支持的语法">
            <HelpCircle size={15} />
            <span className="hidden md:inline">语法</span>
          </button>

          <a
            className="tbtn"
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub 仓库"
          >
            <Github size={15} />
            <span className="hidden md:inline">源码</span>
          </a>
        </div>
      </header>

      {/* 桌面端布局 */}
      <main className="hidden min-h-0 flex-1 gap-3 p-3 lg:flex">
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          {editorPanel}
          <ControlBar
            playing={playing}
            onTogglePlay={togglePlay}
            onPrev={stepPrev}
            onNext={stepNext}
            onReset={reset}
            canPrev={idx > 0}
            canNext={snapshots.length > 0 && idx < snapshots.length - 1}
            idx={Math.min(idx, Math.max(snapshots.length - 1, 0))}
            total={Math.max(snapshots.length - 1, 0)}
            status={statusText}
            speed={speed}
            onSpeed={setSpeed}
          />
          <div className="h-48 flex-none">{ioPanel}</div>
        </section>
        <aside className="flex w-[380px] flex-none flex-col xl:w-[440px]">
          {memoryPanel}
        </aside>
      </main>

      {/* 移动端布局 */}
      <main className="flex min-h-0 flex-1 flex-col p-3 pb-0 lg:hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-3 pb-3">
          {mtab === 'code' && (
            <>
              {editorPanel}
              <ControlBar
                playing={playing}
                onTogglePlay={togglePlay}
                onPrev={stepPrev}
                onNext={stepNext}
                onReset={reset}
                canPrev={idx > 0}
                canNext={snapshots.length > 0 && idx < snapshots.length - 1}
                idx={Math.min(idx, Math.max(snapshots.length - 1, 0))}
                total={Math.max(snapshots.length - 1, 0)}
                status={statusText}
                speed={speed}
                onSpeed={setSpeed}
              />
            </>
          )}
          {mtab === 'mem' && memoryPanel}
          {mtab === 'io' && ioPanel}
        </div>
        <nav
          className="flex flex-none border-t border-[var(--line)] bg-[var(--panel)]"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <button className="mtab" data-active={mtab === 'code'} onClick={() => setMtab('code')}>
            <Code2 size={15} /> 代码
          </button>
          <button className="mtab" data-active={mtab === 'mem'} onClick={() => setMtab('mem')}>
            <MemoryStick size={15} /> 内存
          </button>
          <button className="mtab" data-active={mtab === 'io'} onClick={() => setMtab('io')}>
            <TerminalSquare size={15} /> 输出
          </button>
        </nav>
      </main>

      {/* 语法帮助弹层 */}
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowHelp(false)}
          role="dialog"
          aria-modal="true"
          aria-label="支持的语法"
        >
          <div
            className="panel thin-scroll max-h-[80dvh] w-full max-w-lg overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-title justify-between">
              <span>支持的 C 语法</span>
              <button className="tbtn !h-7 !min-w-7 !px-1" onClick={() => setShowHelp(false)} aria-label="关闭">
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3 p-4 text-[13px] leading-relaxed text-[var(--text)]">
              <Section title="类型">
                char / short / int / long / long long / float / double / unsigned /
                指针（多级）/ 数组（多维）/ 字符串字面量（rodata）
              </Section>
              <Section title="语句">
                变量声明与初始化、赋值（= += -= *= /= %=）、if / else、while、do-while、
                for、break、continue、return、函数定义与递归调用、++ / --
              </Section>
              <Section title="表达式">
                算术 / 关系 / 逻辑（短路）/ 位运算、取地址 &、解引用 *、下标 []、
                指针运算、强制类型转换、sizeof
              </Section>
              <Section title="内存函数">
                malloc / calloc / free —— 堆块会画在「堆区」，free 后变墓碑块；
                程序结束仍未 free 的块会红色脉冲告警并计入泄漏报告
              </Section>
              <Section title="内置函数">
                printf（%d %c %f %s %p %x 等）/ putchar / puts；scanf 会跳过并提示
              </Section>
              <Section title="安全检查">
                空指针解引用、use-after-free、double free、堆越界、数组越界、
                未定义变量 / 函数、除以 0、死循环保护（2 万步熔断）
              </Section>
              <Section title="暂不支持">
                struct / union / enum、指针函数、realloc、三元运算符、switch
              </Section>
              <p className="text-[12px] text-[var(--muted)]">
                快捷键：空格 = 运行/暂停，← / → = 上一步 / 单步。
                数据模型：64 位（指针 8 字节，int 4 字节），内存地址为教学演示用的虚拟地址。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-0.5 text-[12px] font-semibold text-[var(--accent)]">{title}</h3>
      <p className="text-[var(--muted)]">{children}</p>
    </div>
  );
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="var(--accent)" strokeWidth="1.4" />
      <rect x="6.5" y="6.5" width="11" height="3" rx="0.6" fill="var(--c-stack)" opacity="0.85" />
      <rect x="6.5" y="10.5" width="11" height="5" rx="0.6" fill="var(--c-heap)" opacity="0.7" />
      <rect x="6.5" y="16.5" width="11" height="1.5" rx="0.6" fill="var(--c-global)" opacity="0.6" />
    </svg>
  );
}
