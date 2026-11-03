import { Pause, Play, RotateCcw, StepBack, StepForward } from 'lucide-react';

interface Props {
  playing: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  canPrev: boolean;
  canNext: boolean;
  idx: number;
  total: number;
  status: string;
  speed: number;
  onSpeed: (v: number) => void;
}

export function ControlBar(p: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] bg-[var(--panel)] px-3 py-2">
      <button
        className="tbtn tbtn-primary"
        onClick={p.onTogglePlay}
        aria-label={p.playing ? '暂停' : '运行'}
      >
        {p.playing ? <Pause size={15} /> : <Play size={15} />}
        <span className="hidden sm:inline">{p.playing ? '暂停' : '运行'}</span>
      </button>
      <button className="tbtn" onClick={p.onPrev} disabled={!p.canPrev} aria-label="上一步">
        <StepBack size={15} />
      </button>
      <button className="tbtn" onClick={p.onNext} disabled={!p.canNext} aria-label="单步">
        <StepForward size={15} />
        <span className="hidden sm:inline">单步</span>
      </button>
      <button className="tbtn" onClick={p.onReset} aria-label="重置">
        <RotateCcw size={15} />
      </button>

      <div className="ml-1 flex items-center gap-2 text-[12px] text-[var(--muted)]">
        <span className="tabular-nums">
          {p.idx} / {p.total}
        </span>
        <span className="hidden text-[var(--faint)] md:inline">{p.status}</span>
      </div>

      <label className="ml-auto flex items-center gap-2 text-[11px] text-[var(--muted)]">
        <span className="hidden sm:inline">速度</span>
        <input
          type="range"
          min={1}
          max={10}
          value={p.speed}
          onChange={(e) => p.onSpeed(Number(e.target.value))}
          className="h-1 w-20 cursor-pointer accent-[var(--accent)] sm:w-28"
          aria-label="播放速度"
        />
      </label>
    </div>
  );
}
