import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HeapBlock, RodataStr, Snapshot, VarInfo } from '../lib/cvm/interp';
import { fmtAddr } from '../lib/cvm/interp';
import { isArray, isPtr, sizeOf, elemType, typeName } from '../lib/cvm/ctypes';

export const PX_PER_BYTE = 8;
const MIN_H = 26;
const MAX_H = 320;

function blockH(size: number): number {
  return Math.max(MIN_H, Math.min(size * PX_PER_BYTE, MAX_H));
}

type Tier = 'compact' | 'mid' | 'full';
function tierOf(h: number): Tier {
  return h < 38 ? 'compact' : h < 64 ? 'mid' : 'full';
}

/** 读取变量当前值并格式化 */
function varValue(v: VarInfo, cells: Record<number, number>): string {
  const ty = v.type;
  if (isArray(ty)) {
    if (ty.base === 'char' && ty.dims.length === 1) {
      let s = '';
      for (let i = 0; i < ty.dims[0]; i++) {
        const c = cells[v.addr + i];
        if (c === undefined || c === 0) break;
        s += String.fromCharCode(c);
      }
      return `"${s}"`;
    }
    const et = elemType(ty);
    const es = sizeOf(et);
    const n = ty.dims[0];
    const items: string[] = [];
    for (let i = 0; i < Math.min(n, 8); i++) {
      const x = cells[v.addr + i * es];
      items.push(x === undefined ? '?' : fmtScalar(x, et));
    }
    return `[${items.join(', ')}${n > 8 ? ', …' : ''}]`;
  }
  const raw = cells[v.addr];
  if (raw === undefined) return '?';
  if (isPtr(ty)) return raw === 0 ? 'NULL' : fmtAddr(raw);
  return fmtScalar(raw, ty);
}

function fmtScalar(x: number, ty: { base: string; ptr: number }): string {
  if (ty.base === 'char' && ty.ptr === 0) {
    const c = Math.trunc(x) & 0xff;
    return c >= 32 && c < 127 ? `'${String.fromCharCode(c)}'` : String(Math.trunc(x));
  }
  if (ty.base === 'float' || ty.base === 'double') {
    return Number.isInteger(x) ? String(x) : String(Math.round(x * 1e6) / 1e6);
  }
  return String(Math.trunc(x));
}

function heapValues(b: HeapBlock, cells: Record<number, number>): string {
  const es = Math.max(b.elemSize, 1);
  const n = Math.floor(b.size / es);
  if (n <= 0) return '';
  const items: string[] = [];
  for (let i = 0; i < Math.min(n, 10); i++) {
    const x = cells[b.addr + i * es];
    items.push(x === undefined ? '?' : String(Math.trunc(x)));
  }
  return `[${items.join(', ')}${n > 10 ? ', …' : ''}]`;
}

interface Arrow {
  key: string;
  fromAddr: number;
  toAddr: number;
  color: string;
  danger: boolean;
}

/** 从快照中提取所有指针引用关系 */
function collectArrows(s: Snapshot): Arrow[] {
  const arrows: Arrow[] = [];
  const resolve = (addr: number): { addr: number; danger: boolean } | null => {
    for (const b of s.state.heap) {
      if (addr >= b.addr && addr < b.addr + b.size) {
        return { addr: b.addr, danger: b.freed };
      }
    }
    const allVars = [...s.state.globals, ...s.state.frames.flatMap((f) => f.vars)];
    for (const v of allVars) {
      if (addr >= v.addr && addr < v.addr + v.size) return { addr: v.addr, danger: false };
    }
    for (const r of s.state.rodata) {
      if (addr >= r.addr && addr < r.addr + r.size) return { addr: r.addr, danger: false };
    }
    return null;
  };

  const allVars = [
    ...s.state.globals,
    ...s.state.frames.flatMap((f) => f.vars),
  ];
  for (const v of allVars) {
    if (!isPtr(v.type) || isArray(v.type)) continue;
    const pv = s.state.cells[v.addr];
    if (pv === undefined || pv === 0) continue;
    const target = resolve(pv);
    if (!target) continue;
    arrows.push({
      key: v.id,
      fromAddr: v.addr,
      toAddr: target.addr,
      color: target.danger ? 'var(--c-danger)' : 'var(--accent)',
      danger: target.danger,
    });
  }
  return arrows;
}

interface Props {
  snapshot: Snapshot | null;
  isFinal: boolean;
}

export function MemoryView({ snapshot, isFinal }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; color: string; key: string; danger: boolean }[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  const arrows = useMemo(() => (snapshot ? collectArrows(snapshot) : []), [snapshot]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !snapshot) {
      setPaths([]);
      return;
    }
    const compute = () => {
      const cRect = container.getBoundingClientRect();
      const out: { d: string; color: string; key: string; danger: boolean }[] = [];
      for (const a of arrows) {
        const fromEl = container.querySelector<HTMLElement>(`[data-addr="${a.fromAddr}"]`);
        const toEl = container.querySelector<HTMLElement>(`[data-addr="${a.toAddr}"]`);
        if (!fromEl || !toEl || fromEl === toEl) continue;
        const fr = fromEl.getBoundingClientRect();
        const tr = toEl.getBoundingClientRect();
        const x1 = fr.right - cRect.left + container.scrollLeft;
        const y1 = fr.top + fr.height / 2 - cRect.top + container.scrollTop;
        const x2 = tr.left - cRect.left + container.scrollLeft;
        const y2 = tr.top + tr.height / 2 - cRect.top + container.scrollTop;
        const dx = Math.max(20, Math.abs(x2 - x1) * 0.35);
        out.push({
          key: a.key,
          color: a.color,
          danger: a.danger,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        });
      }
      setPaths(out);
      setSvgSize({ w: container.scrollWidth, h: container.scrollHeight });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    const t = window.setTimeout(compute, 60);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [snapshot, arrows]);

  if (!snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <ChipIcon />
        <p className="text-[13px] text-[var(--muted)]">
          点击「运行」或「单步」，
          <br />
          这里会实时显示每个变量在内存中的位置和大小。
        </p>
      </div>
    );
  }

  const s = snapshot.state;
  const leakedIds = new Set(
    isFinal && s.status === 'done' ? s.heap.filter((b) => !b.freed).map((b) => b.id) : [],
  );

  return (
    <div ref={scrollRef} className="thin-scroll relative h-full overflow-auto">
      {/* 指针箭头层 */}
      <svg
        className="pointer-events-none absolute left-0 top-0 z-10"
        width={svgSize.w}
        height={svgSize.h}
        aria-hidden
      >
        <defs>
          {paths.map((p) => (
            <marker
              key={p.key}
              id={`arrow-${p.key}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={p.color} />
            </marker>
          ))}
        </defs>
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={p.danger ? 2 : 1.5}
            strokeDasharray={p.danger ? '5 3' : undefined}
            markerEnd={`url(#arrow-${p.key})`}
            opacity={0.9}
          />
        ))}
      </svg>

      {/* 栈区 */}
      <section className="border-b border-[var(--line)] pb-3">
        <div className="seg-label">
          <span className="flex items-center gap-2">
            <span className="dot" style={{ background: 'var(--c-stack)' }} />
            栈区 STACK
          </span>
          <span>向低地址生长 ↓</span>
        </div>
        <div className="px-3">
          {s.frames.length === 0 && (
            <p className="py-2 text-[12px] text-[var(--faint)]">（尚未进入 main / 已返回）</p>
          )}
          {[...s.frames].reverse().map((f, fi) => (
            <div key={f.id}>
              <div className="frame-head" style={fi === 0 ? { marginTop: 2 } : undefined}>
                <span className="text-[var(--c-stack)]">{f.funcName}()</span>
                {fi === 0 && <span className="text-[10px] text-[var(--faint)]">· 栈顶</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                {f.vars.length === 0 && (
                  <p className="text-[11px] text-[var(--faint)]">（无局部变量）</p>
                )}
                {f.vars.map((v) => (
                  <VarBlock key={v.id} v={v} snapshot={snapshot} seg="seg-stack" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 堆区 */}
      <section className="border-b border-[var(--line)] pb-3">
        <div className="seg-label">
          <span className="flex items-center gap-2">
            <span className="dot" style={{ background: 'var(--c-heap)' }} />
            堆区 HEAP
          </span>
          <span>malloc / free 管理</span>
        </div>
        <div className="flex flex-col gap-1.5 px-3">
          {s.heap.length === 0 && (
            <p className="py-2 text-[12px] text-[var(--faint)]">（尚未申请堆内存）</p>
          )}
          {s.heap.map((b) => (
            <HeapBlockView
              key={b.id}
              b={b}
              snapshot={snapshot}
              leaking={leakedIds.has(b.id)}
            />
          ))}
        </div>
      </section>

      {/* 全局 / 静态区 */}
      <section className="pb-4">
        <div className="seg-label">
          <span className="flex items-center gap-2">
            <span className="dot" style={{ background: 'var(--c-global)' }} />
            全局 / 静态区
          </span>
          <span>.data · .bss · rodata</span>
        </div>
        <div className="flex flex-col gap-1.5 px-3">
          {s.globals.length === 0 && s.rodata.length === 0 && (
            <p className="py-2 text-[12px] text-[var(--faint)]">（无全局变量）</p>
          )}
          {s.globals.map((v) => (
            <VarBlock key={v.id} v={v} snapshot={snapshot} seg="seg-global" />
          ))}
          {s.rodata.map((r: RodataStr) => {
            const h = blockH(r.size);
            const t = tierOf(h);
            return (
              <div key={r.addr} data-addr={r.addr} className={`mem-block seg-global tier-${t}`} style={{ height: h }}>
                {t === 'compact' ? (
                  <>
                    <span className="vname">字符串常量</span>
                    <span className="vval">"{clip(r.value, 18)}"</span>
                    <span className="addr">{r.size}B · {fmtAddr(r.addr)}</span>
                  </>
                ) : (
                  <>
                    <div className="mem-row">
                      <span className="vname">字符串常量</span>
                      <span className="addr">{fmtAddr(r.addr)}</span>
                    </div>
                    {t === 'full' && <span className="vmeta">{r.size} 字节 · rodata</span>}
                    <span className="vval">"{clip(r.value, 30)}"</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function VarBlock({ v, snapshot, seg }: { v: VarInfo; snapshot: Snapshot; seg: string }) {
  const val = varValue(v, snapshot.state.cells);
  const h = blockH(v.size);
  const t = tierOf(h);
  const changed = snapshot.changed.includes(v.addr);
  return (
    <div
      data-addr={v.addr}
      className={`mem-block ${seg} tier-${t} ${changed ? 'mem-changed' : ''}`}
      style={{ height: h }}
      title={`${typeName(v.type)} ${v.name} · ${v.size} 字节 · ${fmtAddr(v.addr)}`}
    >
      {t === 'compact' ? (
        <>
          <span className="vname">{v.name}</span>
          <span className="vval">{val}</span>
          <span className="addr">
            {v.size}B · {fmtAddr(v.addr)}
          </span>
        </>
      ) : (
        <>
          <div className="mem-row">
            <span className="vname">{v.name}</span>
            <span className="addr">{fmtAddr(v.addr)}</span>
          </div>
          {t === 'full' && (
            <span className="vmeta">
              {typeName(v.type)} · {v.size} 字节 · L{v.line}
            </span>
          )}
          {t === 'mid' && (
            <span className="vmeta">
              {typeName(v.type)} · {v.size}B
            </span>
          )}
          <span className="vval">{val}</span>
        </>
      )}
    </div>
  );
}

function HeapBlockView({ b, snapshot, leaking }: { b: HeapBlock; snapshot: Snapshot; leaking: boolean }) {
  const h = blockH(b.size);
  const t = tierOf(h);
  const cls = leaking ? 'mem-leak' : b.freed ? 'mem-freed' : 'seg-heap';
  const name = b.freed ? '已释放' : leaking ? '泄漏的块' : '堆内存块';
  const meta = `${b.size} 字节 · malloc @L${b.line}${b.freed && b.freedLine ? ` · free @L${b.freedLine}` : ''}`;
  const val = leaking ? '⚠ 程序结束仍未 free' : b.freed ? '' : heapValues(b, snapshot.state.cells);
  return (
    <div
      data-addr={b.addr}
      className={`mem-block ${cls} tier-${t} ${snapshot.changed.includes(b.addr) && !b.freed ? 'mem-changed' : ''}`}
      style={{ height: h }}
      title={`堆内存块 · ${b.size} 字节 · ${fmtAddr(b.addr)} · 分配于第 ${b.line} 行`}
    >
      {t === 'compact' ? (
        <>
          <span className="vname">{name}</span>
          {val && <span className="vval">{val}</span>}
          <span className="addr">{b.size}B · L{b.line}</span>
        </>
      ) : (
        <>
          <div className="mem-row">
            <span className="vname">{name}</span>
            <span className="addr">{fmtAddr(b.addr)}</span>
          </div>
          {t === 'full' ? <span className="vmeta">{meta}</span> : <span className="vmeta">{b.size}B · malloc@L{b.line}</span>}
          {val && (
            <span className="vval" style={leaking ? { color: 'var(--c-danger)' } : undefined}>
              {val}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function ChipIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="1.2" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.5" />
      <path d="M9 6V3M15 6V3M9 21v-3M15 21v-3M6 9H3M6 15H3M21 9h-3M21 15h-3" />
    </svg>
  );
}
