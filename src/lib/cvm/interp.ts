// 解释器：在虚拟内存模型上逐语句执行 C 子集
// 内存分区：rodata(字符串常量) / 全局区 / 堆区 / 栈区
import {
  decay, elemType, isArray, isFloat, isPtr, sizeOf, t, typeName,
  type CType,
} from './ctypes';
import { parse, ParseError, type Expr, type FuncDef, type Program, type Stmt } from './parser';
import { LexError } from './lexer';

// ---------- 运行时结构（全部可 JSON 序列化） ----------
export interface VarInfo {
  id: string;
  name: string;
  type: CType;
  addr: number;
  size: number;
  line: number;
}

export interface FrameInfo {
  id: string;
  funcName: string;
  line: number;
  vars: VarInfo[];
}

export interface HeapBlock {
  id: string;
  addr: number;
  size: number;
  elemSize: number;
  line: number;
  freed: boolean;
  freedLine?: number;
}

export interface RodataStr {
  addr: number;
  value: string;
  size: number;
}

export type WarnLevel = 'leak' | 'error' | 'warn' | 'info';

export interface Warning {
  id: number;
  level: WarnLevel;
  message: string;
  line?: number;
}

export interface SimState {
  globals: VarInfo[];
  frames: FrameInfo[];
  heap: HeapBlock[];
  rodata: RodataStr[];
  cells: Record<number, number>;
  output: string;
  warnings: Warning[];
  heapTop: number;
  stackTop: number;
  globalTop: number;
  rodataTop: number;
  status: 'ok' | 'done' | 'error';
}

export interface StepEvent {
  line: number;
  kind: 'stmt' | 'cond' | 'call' | 'ret';
  note?: string;
}

export interface Snapshot {
  state: SimState;
  line: number;
  note?: string;
  /** 本步被写入的地址（用于高亮） */
  changed: number[];
}

export interface RunResult {
  snapshots: Snapshot[];
  error?: { message: string; line: number };
}

// ---------- 值 ----------
interface Val { type: CType; v: number }

type Sig =
  | { t: 'n' }
  | { t: 'break' }
  | { t: 'continue' }
  | { t: 'ret'; v: Val | null };

const SIG_N: Sig = { t: 'n' };

const BASES = {
  rodata: 0x40000000,
  global: 0x50000000,
  heap: 0x60000000,
  stack: 0x7fff0000,
} as const;

const STEP_CAP = 20000;

export class CompileError extends Error {
  line: number;
  constructor(msg: string, line: number) {
    super(msg);
    this.line = line;
  }
}

class RuntimeError extends Error {
  line: number;
  constructor(msg: string, line: number) {
    super(msg);
    this.line = line;
  }
}

let uid = 0;
const nid = () => `id${++uid}`;

export class Simulator {
  state: SimState;
  private program: Program;
  private funcMap: Map<string, FuncDef>;
  private stepCount = 0;
  private changed: number[] = [];
  private warnId = 0;
  private warnedOnce = new Set<string>();

  constructor(src: string) {
    this.program = parse(src); // 可能抛 ParseError / LexError
    this.funcMap = new Map(this.program.funcs.map((f) => [f.name, f]));
    this.state = {
      globals: [],
      frames: [],
      heap: [],
      rodata: [],
      cells: {},
      output: '',
      warnings: [],
      heapTop: BASES.heap,
      stackTop: BASES.stack,
      globalTop: BASES.global,
      rodataTop: BASES.rodata,
      status: 'ok',
    };
  }

  /** 一直跑到结束（或步数上限），返回全部快照 */
  runAll(): RunResult {
    const snapshots: Snapshot[] = [];
    const snap = (line: number, note?: string) => {
      snapshots.push({
        state: JSON.parse(JSON.stringify(this.state)) as SimState,
        line,
        note,
        changed: [...this.changed],
      });
      this.changed = [];
    };

    const main = this.funcMap.get('main');
    if (!main) {
      return { snapshots, error: { message: '找不到 main 函数', line: 1 } };
    }

    snap(0, '程序载入'); // 初始空快照
    const gen = this.execProgram(main);
    try {
      for (;;) {
        const r = gen.next();
        if (r.done) break;
        if (++this.stepCount > STEP_CAP) {
          this.addWarn('error', `执行步数超过 ${STEP_CAP}，已中止（可能存在死循环）`);
          this.state.status = 'error';
          break;
        }
        snap(r.value.line, r.value.note);
      }
    } catch (e) {
      if (e instanceof RuntimeError) {
        this.addWarn('error', `第 ${e.line} 行：${e.message}`, e.line);
      } else if (e instanceof Error) {
        this.addWarn('error', e.message);
      }
      this.state.status = 'error';
      snap(this.lastLine(snapshots), '运行出错');
    }
    if (this.state.status === 'ok') {
      this.state.status = 'done';
      this.detectLeaks();
      snap(this.lastLine(snapshots), '程序结束');
    }
    return { snapshots };
  }

  private lastLine(snaps: Snapshot[]): number {
    return snaps.length ? snaps[snaps.length - 1].line : 0;
  }

  // ---------- 警告 ----------
  private addWarn(level: WarnLevel, message: string, line?: number) {
    this.state.warnings.push({ id: ++this.warnId, level, message, line });
  }

  private warnOnce(key: string, level: WarnLevel, message: string, line?: number) {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.addWarn(level, message, line);
  }

  // ---------- 程序执行 ----------
  private *execProgram(main: FuncDef): Generator<StepEvent, void, unknown> {
    // 初始化全局变量
    for (const g of this.program.globals) {
      yield* this.execStmt(g, null);
    }
    // 调用 main
    const ret = yield* this.callFunction(main, [], main.line);
    void ret;
  }

  private *callFunction(
    fn: FuncDef,
    args: Val[],
    callLine: number,
  ): Generator<StepEvent, Val | null, unknown> {
    const frame: FrameInfo = { id: nid(), funcName: fn.name, line: callLine, vars: [] };
    this.state.frames.push(frame);
    // 参数入栈
    fn.params.forEach((p, i) => {
      const arg = args[i] ?? { type: p.cType, v: 0 };
      const addr = this.allocStack(p.cType);
      this.state.cells[addr] = arg.v;
      frame.vars.push({
        id: nid(), name: p.name, type: p.cType, addr,
        size: sizeOf(p.cType), line: fn.line,
      });
      this.changed.push(addr);
    });
    let retVal: Val | null = null;
    const sig = yield* this.execStmt(fn.body, frame);
    if (sig.t === 'ret') retVal = sig.v;
    // 弹出栈帧：回收该帧所有变量的单元
    for (const v of frame.vars) {
      this.removeCells(v.addr, v.size);
    }
    this.state.frames.pop();
    return retVal;
  }

  // ---------- 内存分配 ----------
  private alignUp(x: number, a: number): number {
    return Math.ceil(x / a) * a;
  }

  private allocStack(type: CType): number {
    const size = sizeOf(type);
    const align = Math.min(size, 8);
    let top = this.state.stackTop - size;
    top = Math.floor(top / align) * align;
    this.state.stackTop = top;
    return top;
  }

  private allocCells(addr: number, type: CType) {
    if (isArray(type)) {
      const es = sizeOf(elemType(type));
      const count = type.dims[0];
      for (let i = 0; i < count; i++) {
        const eAddr = addr + i * es;
        const et = elemType(type);
        if (isArray(et)) this.allocCells(eAddr, et);
        else this.state.cells[eAddr] = 0;
      }
    } else {
      this.state.cells[addr] = 0;
    }
  }

  private removeCells(addr: number, size: number) {
    // 只删除存在的键（按 1 字节步长兜底）
    for (let a = addr; a < addr + size; a++) {
      if (a in this.state.cells) delete this.state.cells[a];
    }
  }

  private declareVar(
    frame: FrameInfo | null,
    name: string,
    type: CType,
    line: number,
  ): VarInfo {
    const size = sizeOf(type);
    let addr: number;
    if (frame) {
      addr = this.allocStack(type);
    } else {
      addr = this.state.globalTop;
      this.state.globalTop = this.alignUp(this.state.globalTop + size, Math.min(size, 8));
    }
    this.allocCells(addr, type);
    const info: VarInfo = { id: nid(), name, type, addr, size, line };
    if (frame) frame.vars.push(info);
    else this.state.globals.push(info);
    this.changed.push(addr);
    return info;
  }

  private heapAlloc(bytes: number, elemSize: number, line: number): number {
    const size = Math.max(bytes, 1);
    const addr = this.state.heapTop;
    this.state.heapTop = this.alignUp(addr + size, 8);
    // 按字节建立单元，元素尺寸由后续访问推断
    for (let a = addr; a < addr + size; a++) {
      this.state.cells[a] = 0;
    }
    this.state.heap.push({
      id: nid(), addr, size, elemSize: Math.max(elemSize, 1),
      line, freed: false,
    });
    this.changed.push(addr);
    return addr;
  }

  // ---------- 单元读写（带安全检查） ----------
  private findHeapBlock(addr: number): HeapBlock | undefined {
    return this.state.heap.find((b) => addr >= b.addr && addr < b.addr + b.size);
  }

  private readCell(addr: number, line: number): number {
    if (addr === 0) throw new RuntimeError('空指针解引用（NULL）', line);
    if (!(addr in this.state.cells)) {
      throw new RuntimeError(`读取了未分配的内存地址 ${fmtAddr(addr)}`, line);
    }
    const hb = this.findHeapBlock(addr);
    if (hb && hb.freed) {
      this.warnOnce(
        `uaf-r-${hb.id}`,
        'error',
        `第 ${line} 行：读取了已释放的堆内存（${fmtAddr(hb.addr)}，第 ${hb.line} 行 malloc，第 ${hb.freedLine} 行 free）—— use-after-free`,
        line,
      );
    }
    return this.state.cells[addr];
  }

  private writeCell(addr: number, v: number, line: number, elemHint?: number) {
    if (addr === 0) throw new RuntimeError('向 NULL 指针写入数据', line);
    if (!(addr in this.state.cells)) {
      // 判断是否越界
      const hb = this.findHeapBlock(addr);
      if (hb) {
        throw new RuntimeError(
          `堆内存越界写入：块 [${fmtAddr(hb.addr)}, +${hb.size}B)，写到了 ${fmtAddr(addr)}`, line);
      }
      throw new RuntimeError(`写入了未分配的内存地址 ${fmtAddr(addr)}`, line);
    }
    const hb = this.findHeapBlock(addr);
    if (hb) {
      if (hb.freed) {
        this.warnOnce(
          `uaf-w-${hb.id}`,
          'error',
          `第 ${line} 行：向已释放的堆内存写入（${fmtAddr(hb.addr)}）—— use-after-free`,
          line,
        );
      } else if (
        elemHint !== undefined && elemHint > 0 && elemHint < hb.size &&
        hb.elemSize === hb.size && hb.size % elemHint === 0
      ) {
        // 通过 p[i] / *p 的写入推断堆块元素尺寸（用于展示）
        hb.elemSize = elemHint;
      }
    }
    this.state.cells[addr] = v;
    this.changed.push(addr);
  }

  // ---------- 变量查找 ----------
  private lookupVar(frame: FrameInfo | null, name: string, line: number): VarInfo {
    if (frame) {
      for (let i = frame.vars.length - 1; i >= 0; i--) {
        if (frame.vars[i].name === name) return frame.vars[i];
      }
    }
    for (let i = this.state.globals.length - 1; i >= 0; i--) {
      if (this.state.globals[i].name === name) return this.state.globals[i];
    }
    throw new RuntimeError(`未定义的变量 '${name}'`, line);
  }

  // ---------- 语句执行 ----------
  private *execStmt(
    stmt: Stmt,
    frame: FrameInfo | null,
  ): Generator<StepEvent, Sig, unknown> {
    switch (stmt.kind) {
      case 'empty':
        return SIG_N;

      case 'block': {
        const mark = frame ? frame.vars.length : 0;
        const truncate = () => {
          if (frame && frame.vars.length > mark) {
            const removed = frame.vars.splice(mark);
            for (const v of removed) this.removeCells(v.addr, v.size);
          }
        };
        try {
          for (const s of stmt.stmts) {
            const sig = yield* this.execStmt(s, frame);
            if (sig.t !== 'n') {
              truncate();
              return sig;
            }
          }
          truncate();
          return SIG_N;
        } catch (e) {
          // 运行出错时保留现场，便于在内存视图中排查
          if (!(e instanceof RuntimeError)) truncate();
          throw e;
        }
      }

      case 'decl': {
        yield { line: stmt.line, kind: 'stmt' };
        const declType: CType = { ...stmt.cType, dims: [...stmt.dims] };
        // 推导未指定长度的数组：char s[] = ".." / int a[] = {..}
        if (declType.dims.length > 0 && declType.dims[0] === 0) {
          if (Array.isArray(stmt.init)) {
            declType.dims[0] = stmt.init.length;
          } else if (stmt.init?.kind === 'str' && declType.base === 'char') {
            declType.dims[0] = stmt.init.value.length + 1;
          } else {
            throw new RuntimeError('数组长度不能为 0，且无法从初始化推导', stmt.line);
          }
        }
        const info = this.declareVar(frame, stmt.name, declType, stmt.line);
        if (stmt.init !== null) {
          if (Array.isArray(stmt.init)) {
            // 数组初始化列表
            if (!isArray(declType)) {
              throw new RuntimeError('只有数组可以使用 { ... } 初始化', stmt.line);
            }
            const et = elemType(declType);
            const es = sizeOf(et);
            const count = declType.dims[0];
            if (stmt.init.length > count) {
              this.addWarn('warn', `第 ${stmt.line} 行：初始化列表长度超过数组大小 ${count}，多余项被忽略`, stmt.line);
            }
            for (let i = 0; i < Math.min(stmt.init.length, count); i++) {
              const v = yield* this.evalExpr(stmt.init[i], frame);
              this.writeCell(info.addr + i * es, this.convert(v, et).v, stmt.line);
            }
          } else if (stmt.init.kind === 'str' && declType.base === 'char' && isArray(declType)) {
            // char s[] = "hello"
            const str = stmt.init.value;
            const n = declType.dims[0];
            for (let i = 0; i < Math.min(str.length, n); i++) {
              this.writeCell(info.addr + i, str.charCodeAt(i), stmt.line);
            }
            if (str.length < n) this.writeCell(info.addr + str.length, 0, stmt.line);
          } else {
            const v = yield* this.evalExpr(stmt.init, frame);
            const target = isArray(declType) ? decay(declType) : declType;
            this.writeCell(info.addr, this.convert(v, target).v, stmt.line);
          }
        }
        return SIG_N;
      }

      case 'expr': {
        yield { line: stmt.line, kind: 'stmt' };
        yield* this.evalExpr(stmt.expr, frame);
        return SIG_N;
      }

      case 'if': {
        const c = yield* this.evalExpr(stmt.cond, frame);
        yield { line: stmt.line, kind: 'cond', note: c.v ? '条件为真' : '条件为假' };
        if (c.v) return yield* this.execStmt(stmt.then, frame);
        if (stmt.else) return yield* this.execStmt(stmt.else, frame);
        return SIG_N;
      }

      case 'while': {
        for (;;) {
          const c = yield* this.evalExpr(stmt.cond, frame);
          yield { line: stmt.line, kind: 'cond', note: c.v ? '条件为真，进入循环' : '条件为假，退出循环' };
          if (!c.v) return SIG_N;
          const sig = yield* this.execStmt(stmt.body, frame);
          if (sig.t === 'break') return SIG_N;
          if (sig.t === 'ret') return sig;
        }
      }

      case 'doWhile': {
        for (;;) {
          const sig = yield* this.execStmt(stmt.body, frame);
          if (sig.t === 'break') return SIG_N;
          if (sig.t === 'ret') return sig;
          const c = yield* this.evalExpr(stmt.cond, frame);
          yield { line: stmt.line, kind: 'cond', note: c.v ? '条件为真，继续循环' : '条件为假，退出循环' };
          if (!c.v) return SIG_N;
        }
      }

      case 'for': {
        if (stmt.init) yield* this.execStmt(stmt.init, frame);
        const mark = frame ? frame.vars.length : 0;
        try {
          for (;;) {
            if (stmt.cond) {
              const c = yield* this.evalExpr(stmt.cond, frame);
              yield { line: stmt.line, kind: 'cond', note: c.v ? '条件为真，进入循环' : '条件为假，退出循环' };
              if (!c.v) return SIG_N;
            }
            const sig = yield* this.execStmt(stmt.body, frame);
            if (sig.t === 'break') return SIG_N;
            if (sig.t === 'ret') return sig;
            if (stmt.post) {
              yield { line: stmt.line, kind: 'stmt', note: '循环更新' };
              yield* this.evalExpr(stmt.post, frame);
            }
          }
        } finally {
          if (frame && stmt.init && frame.vars.length > mark) {
            // init 中声明的变量在 for 结束时回收
          }
        }
      }

      case 'return': {
        let v: Val | null = null;
        if (stmt.expr) v = yield* this.evalExpr(stmt.expr, frame);
        yield { line: stmt.line, kind: 'ret', note: frame ? `${frame.funcName} 返回` : '返回' };
        return { t: 'ret', v };
      }

      case 'break': return { t: 'break' };
      case 'continue': return { t: 'continue' };
    }
  }

  // ---------- 左值 ----------
  private *evalLValue(
    expr: Expr,
    frame: FrameInfo | null,
  ): Generator<StepEvent, { addr: number; type: CType }, unknown> {
    switch (expr.kind) {
      case 'var': {
        const info = this.lookupVar(frame, expr.name, expr.line);
        if (isArray(info.type)) {
          throw new RuntimeError(`数组 '${expr.name}' 不能整体赋值`, expr.line);
        }
        return { addr: info.addr, type: info.type };
      }
      case 'index': {
        const base = yield* this.evalExpr(expr.arr, frame); // 已退化为指针
        const idx = yield* this.evalExpr(expr.index, frame);
        if (!isPtr(base.type)) {
          throw new RuntimeError('对非指针/数组使用 [ ]', expr.line);
        }
        const et = elemType(base.type);
        const addr = base.v + Math.trunc(idx.v) * sizeOf(et);
        this.checkIndexInRange(base.v, addr, et, expr.line);
        return { addr, type: et };
      }
      case 'un': {
        if (expr.op === '*') {
          const p = yield* this.evalExpr(expr.expr, frame);
          if (!isPtr(p.type)) throw new RuntimeError('对非指针解引用', expr.line);
          return { addr: p.v, type: elemType(p.type) };
        }
        break;
      }
    }
    throw new RuntimeError('赋值目标不是可修改的左值', expr.line);
  }

  private checkIndexInRange(baseAddr: number, addr: number, et: CType, line: number) {
    // 栈/全局数组越界：检查目标地址是否存在
    if (!(addr in this.state.cells)) {
      const hb = this.findHeapBlock(addr);
      if (hb) {
        throw new RuntimeError(
          `堆内存越界访问：块 [${fmtAddr(hb.addr)}, +${hb.size}B)，访问了 ${fmtAddr(addr)}`, line);
      }
      throw new RuntimeError(
        `数组越界访问 ${fmtAddr(addr)}（元素类型 ${typeName(et)}）`, line);
    }
    void baseAddr;
  }

  // ---------- 类型转换 ----------
  private convert(v: Val, target: CType): Val {
    let num = v.v;
    if (!isFloat(target)) {
      if (isPtr(target)) num = Math.trunc(num);
      else num = Math.trunc(num);
    }
    return { type: target, v: num };
  }

  // ---------- 表达式求值 ----------
  private *evalExpr(expr: Expr, frame: FrameInfo | null): Generator<StepEvent, Val, unknown> {
    switch (expr.kind) {
      case 'num':
        return { type: Number.isInteger(expr.value) ? t('int') : t('double'), v: expr.value };
      case 'char':
        return { type: t('char'), v: expr.value.charCodeAt(0) };
      case 'str': {
        const addr = this.internString(expr.value);
        return { type: t('char', { ptr: 1 }), v: addr };
      }
      case 'var': {
        const info = this.lookupVar(frame, expr.name, expr.line);
        if (isArray(info.type)) {
          return { type: decay(info.type), v: info.addr };
        }
        return { type: info.type, v: this.readCell(info.addr, expr.line) };
      }
      case 'index':
      case 'assign':
      case 'un':
        break;
      case 'cast': {
        const v = yield* this.evalExpr(expr.expr, frame);
        return this.convert(v, expr.cType);
      }
      case 'sizeofType':
        return { type: t('int', { unsigned: true }), v: sizeOf(expr.cType) };
      case 'sizeofExpr': {
        const ty = this.staticType(expr.expr, frame, expr.line);
        return { type: t('int', { unsigned: true }), v: sizeOf(ty) };
      }
      case 'bin': {
        // 短路逻辑
        if (expr.op === '&&') {
          const l = yield* this.evalExpr(expr.l, frame);
          if (!l.v) return { type: t('int'), v: 0 };
          const r = yield* this.evalExpr(expr.r, frame);
          return { type: t('int'), v: r.v ? 1 : 0 };
        }
        if (expr.op === '||') {
          const l = yield* this.evalExpr(expr.l, frame);
          if (l.v) return { type: t('int'), v: 1 };
          const r = yield* this.evalExpr(expr.r, frame);
          return { type: t('int'), v: r.v ? 1 : 0 };
        }
        const l = yield* this.evalExpr(expr.l, frame);
        const r = yield* this.evalExpr(expr.r, frame);
        return this.applyBin(expr.op, l, r, expr.line);
      }
      case 'call':
        return yield* this.evalCall(expr, frame);
    }

    // 需要左值/赋值的表达式
    switch (expr.kind) {
      case 'index': {
        const lv = yield* this.evalLValue(expr, frame);
        return { type: lv.type, v: this.readCell(lv.addr, expr.line) };
      }
      case 'un': {
        if (expr.op === '*') {
          const lv = yield* this.evalLValue(expr, frame);
          return { type: lv.type, v: this.readCell(lv.addr, expr.line) };
        }
        if (expr.op === '&') {
          // 取地址
          if (expr.expr.kind === 'var') {
            const info = this.lookupVar(frame, expr.expr.name, expr.line);
            const pt = isArray(info.type)
              ? { ...decay(info.type) }
              : { ...info.type, ptr: info.type.ptr + 1, dims: [] };
            return { type: pt, v: info.addr };
          }
          const lv = yield* this.evalLValue(expr.expr, frame);
          return { type: { ...lv.type, ptr: lv.type.ptr + 1, dims: [] }, v: lv.addr };
        }
        if (expr.op === '-' || expr.op === '!' || expr.op === '~') {
          const v = yield* this.evalExpr(expr.expr, frame);
          if (expr.op === '-') return { type: v.type, v: -v.v };
          if (expr.op === '!') return { type: t('int'), v: v.v ? 0 : 1 };
          return { type: v.type, v: ~Math.trunc(v.v) };
        }
        if (expr.op === '++' || expr.op === '--') {
          const lv = yield* this.evalLValue(expr.expr, frame);
          const old = this.readCell(lv.addr, expr.line);
          const delta = isPtr(lv.type) ? sizeOf(elemType(lv.type)) : 1;
          const nv = old + (expr.op === '++' ? delta : -delta);
          this.writeCell(lv.addr, nv, expr.line, sizeOf(lv.type));
          return { type: lv.type, v: expr.prefix ? nv : old };
        }
        break;
      }
      case 'assign': {
        const lv = yield* this.evalLValue(expr.target, frame);
        const rv = yield* this.evalExpr(expr.value, frame);
        let nv: Val;
        if (expr.op === '=') {
          nv = this.convert(rv, lv.type);
        } else {
          const cur: Val = { type: lv.type, v: this.readCell(lv.addr, expr.line) };
          const op = expr.op[0] as '+' | '-' | '*' | '/' | '%';
          nv = this.convert(this.applyBin(op, cur, rv, expr.line), lv.type);
        }
        this.writeCell(lv.addr, nv.v, expr.line, sizeOf(lv.type));
        return nv;
      }
    }
    throw new RuntimeError('无法求值的表达式', expr.line);
  }

  private applyBin(op: string, l: Val, r: Val, line: number): Val {
    // 指针运算
    if (isPtr(l.type) && !isPtr(r.type) && (op === '+' || op === '-')) {
      const es = sizeOf(elemType(l.type));
      return { type: l.type, v: l.v + (op === '+' ? 1 : -1) * Math.trunc(r.v) * es };
    }
    if (isPtr(r.type) && !isPtr(l.type) && op === '+') {
      const es = sizeOf(elemType(r.type));
      return { type: r.type, v: r.v + Math.trunc(l.v) * es };
    }
    if (isPtr(l.type) && isPtr(r.type) && op === '-') {
      const es = sizeOf(elemType(l.type));
      return { type: t('long'), v: Math.trunc((l.v - r.v) / es) };
    }
    // 比较
    const cmp = (f: (a: number, b: number) => boolean): Val => ({ type: t('int'), v: f(l.v, r.v) ? 1 : 0 });
    switch (op) {
      case '==': return cmp((a, b) => a === b);
      case '!=': return cmp((a, b) => a !== b);
      case '<': return cmp((a, b) => a < b);
      case '>': return cmp((a, b) => a > b);
      case '<=': return cmp((a, b) => a <= b);
      case '>=': return cmp((a, b) => a >= b);
    }
    const floaty = isFloat(l.type) || isFloat(r.type);
    const rt: CType = floaty ? t('double') : t('long');
    const li = Math.trunc(l.v);
    const ri = Math.trunc(r.v);
    switch (op) {
      case '+': return { type: rt, v: l.v + r.v };
      case '-': return { type: rt, v: l.v - r.v };
      case '*': return { type: rt, v: l.v * r.v };
      case '/':
        if (r.v === 0) throw new RuntimeError('除以 0', line);
        return { type: rt, v: floaty ? l.v / r.v : Math.trunc(li / ri) };
      case '%':
        if (ri === 0) throw new RuntimeError('对 0 取模', line);
        return { type: t('long'), v: li % ri };
      case '&': return { type: t('long'), v: li & ri };
      case '|': return { type: t('long'), v: li | ri };
      case '^': return { type: t('long'), v: li ^ ri };
      case '<<': return { type: t('long'), v: li << ri };
      case '>>': return { type: t('long'), v: li >> ri };
    }
    throw new RuntimeError(`不支持的运算符 '${op}'`, line);
  }

  // ---------- 静态类型推导（给 sizeof(expr) 用） ----------
  private staticType(expr: Expr, frame: FrameInfo | null, line: number): CType {
    switch (expr.kind) {
      case 'num': return t('int');
      case 'char': return t('int');
      case 'str': return t('char', { ptr: 1 });
      case 'var': {
        const info = this.lookupVar(frame, expr.name, line);
        return isArray(info.type) ? decay(info.type) : info.type;
      }
      case 'index': {
        const at = this.staticType(expr.arr, frame, line);
        return elemType(at);
      }
      case 'un':
        if (expr.op === '*') return elemType(this.staticType(expr.expr, frame, line));
        if (expr.op === '&') {
          const it = this.staticType(expr.expr, frame, line);
          return { ...it, ptr: it.ptr + 1, dims: [] };
        }
        return t('int');
      case 'cast': return expr.cType;
      case 'call': {
        const fn = this.funcMap.get(expr.name);
        return fn ? fn.retType : t('int');
      }
      case 'assign': return this.staticType(expr.target, frame, line);
      case 'bin': return t('int');
      case 'sizeofExpr':
      case 'sizeofType': return t('int', { unsigned: true });
    }
  }

  // ---------- 字符串常量池 ----------
  private internString(s: string): number {
    const found = this.state.rodata.find((r) => r.value === s);
    if (found) return found.addr;
    const addr = this.state.rodataTop;
    const size = s.length + 1;
    for (let i = 0; i < s.length; i++) this.state.cells[addr + i] = s.charCodeAt(i);
    this.state.cells[addr + s.length] = 0;
    this.state.rodata.push({ addr, value: s, size });
    this.state.rodataTop = this.alignUp(addr + size, 8);
    return addr;
  }

  private readCString(addr: number, line: number): string {
    let out = '';
    let a = addr;
    for (let i = 0; i < 4096; i++) {
      if (!(a in this.state.cells)) break;
      const hb = this.findHeapBlock(a);
      if (hb && hb.freed) {
        this.warnOnce(`uaf-s-${hb.id}`, 'error', `第 ${line} 行：读取了已释放的堆字符串`, line);
        break;
      }
      const c = this.state.cells[a];
      if (c === 0) break;
      out += String.fromCharCode(c);
      a++;
    }
    return out;
  }

  // ---------- 函数调用（内置 + 用户） ----------
  private *evalCall(
    expr: Extract<Expr, { kind: 'call' }>,
    frame: FrameInfo | null,
  ): Generator<StepEvent, Val, unknown> {
    const { name, args, line } = expr;

    if (name === 'malloc' || name === 'calloc' || name === 'realloc' || name === 'free' || name === 'printf' || name === 'putchar' || name === 'puts' || name === 'scanf') {
      return yield* this.evalBuiltin(name, args, line, frame);
    }

    const fn = this.funcMap.get(name);
    if (!fn) {
      throw new RuntimeError(`调用了未定义的函数 '${name}'（本工具内置支持 malloc/calloc/free/printf/putchar/puts）`, line);
    }
    const argVals: Val[] = [];
    for (const a of args) argVals.push(yield* this.evalExpr(a, frame));
    const ret = yield* this.callFunction(fn, argVals, line);
    return ret ?? { type: fn.retType, v: 0 };
  }

  private *evalBuiltin(
    name: string,
    args: Expr[],
    line: number,
    frame: FrameInfo | null,
  ): Generator<StepEvent, Val, unknown> {
    switch (name) {
      case 'malloc': {
        if (args.length !== 1) throw new RuntimeError('malloc 需要 1 个参数', line);
        const sz = yield* this.evalExpr(args[0], frame);
        const bytes = Math.max(Math.trunc(sz.v), 0);
        const addr = this.heapAlloc(bytes, bytes, line);
        return { type: t('void', { ptr: 1 }), v: addr };
      }
      case 'calloc': {
        if (args.length !== 2) throw new RuntimeError('calloc 需要 2 个参数', line);
        const n = yield* this.evalExpr(args[0], frame);
        const sz = yield* this.evalExpr(args[1], frame);
        const addr = this.heapAlloc(Math.trunc(n.v) * Math.trunc(sz.v), Math.trunc(sz.v), line);
        return { type: t('void', { ptr: 1 }), v: addr };
      }
      case 'free': {
        if (args.length !== 1) throw new RuntimeError('free 需要 1 个参数', line);
        const p = yield* this.evalExpr(args[0], frame);
        if (p.v === 0) return { type: t('void'), v: 0 }; // free(NULL) 合法
        const hb = this.state.heap.find((b) => b.addr === p.v);
        if (!hb) {
          throw new RuntimeError(
            `free 了非法指针 ${fmtAddr(p.v)}（不是 malloc/calloc 返回的块首地址）`, line);
        }
        if (hb.freed) {
          throw new RuntimeError(
            `重复释放（double free）${fmtAddr(hb.addr)}，该块已在第 ${hb.freedLine} 行释放`, line);
        }
        hb.freed = true;
        hb.freedLine = line;
        this.changed.push(hb.addr);
        return { type: t('void'), v: 0 };
      }
      case 'realloc': {
        throw new RuntimeError('本工具暂不支持 realloc，请用 malloc + 拷贝代替', line);
      }
      case 'printf': {
        if (args.length < 1) throw new RuntimeError('printf 至少需要格式串参数', line);
        const fmtVal = yield* this.evalExpr(args[0], frame);
        if (!isPtr(fmtVal.type) && fmtVal.v !== 0) {
          throw new RuntimeError('printf 第一个参数必须是字符串', line);
        }
        const fmt = this.readCString(fmtVal.v, line);
        const argVals: Val[] = [];
        for (let i = 1; i < args.length; i++) {
          argVals.push(yield* this.evalExpr(args[i], frame));
        }
        this.state.output += this.format(fmt, argVals, line);
        return { type: t('int'), v: 0 };
      }
      case 'putchar': {
        const c = yield* this.evalExpr(args[0], frame);
        this.state.output += String.fromCharCode(Math.trunc(c.v) & 0xff);
        return { type: t('int'), v: 0 };
      }
      case 'puts': {
        const s = yield* this.evalExpr(args[0], frame);
        this.state.output += this.readCString(s.v, line) + '\n';
        return { type: t('int'), v: 0 };
      }
      case 'scanf': {
        this.warnOnce('scanf', 'warn', `第 ${line} 行：本工具不支持交互输入，scanf 已跳过（变量保持初始值 0）`, line);
        return { type: t('int'), v: 0 };
      }
    }
    throw new RuntimeError(`未实现的内置函数 '${name}'`, line);
  }

  // ---------- printf 格式化 ----------
  private format(fmt: string, args: Val[], line: number): string {
    let out = '';
    let ai = 0;
    const re = /%([-+0-9.]*)(l{0,2})([diucfxXsp%])/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fmt))) {
      out += fmt.slice(last, m.index);
      last = m.index + m[0].length;
      const [, flag, , spec] = m;
      if (spec === '%') { out += '%'; continue; }
      const arg = args[ai++];
      if (arg === undefined) {
        this.addWarn('warn', `第 ${line} 行：printf 格式符 '%${spec}' 缺少对应参数`, line);
        out += `%${spec}`;
        continue;
      }
      switch (spec) {
        case 'd': case 'i': case 'u': {
          let s = String(Math.trunc(arg.v));
          const prec = flag.match(/\.(\d+)/);
          if (prec) s = s.padStart(parseInt(prec[1], 10), '0');
          out += s;
          break;
        }
        case 'x': case 'X': {
          const s = (Math.trunc(arg.v) >>> 0).toString(16);
          out += spec === 'X' ? s.toUpperCase() : s;
          break;
        }
        case 'c': out += String.fromCharCode(Math.trunc(arg.v) & 0xff); break;
        case 'f': {
          const prec = flag.match(/\.(\d+)/);
          out += arg.v.toFixed(prec ? parseInt(prec[1], 10) : 6);
          break;
        }
        case 's':
          out += isPtr(arg.type) ? this.readCString(arg.v, line) : String(arg.v);
          break;
        case 'p': out += fmtAddr(arg.v); break;
      }
    }
    out += fmt.slice(last);
    return out;
  }

  // ---------- 泄漏检测 ----------
  private detectLeaks() {
    const leaked = this.state.heap.filter((b) => !b.freed);
    if (leaked.length === 0) {
      this.addWarn('info', `程序结束：共申请 ${this.state.heap.length} 块堆内存，全部正确释放，无内存泄漏`);
      return;
    }
    const total = leaked.reduce((s, b) => s + b.size, 0);
    this.addWarn('leak', `检测到 ${leaked.length} 处内存泄漏，共 ${total} 字节未释放`);
    for (const b of leaked) {
      this.addWarn(
        'leak',
        `泄漏：${fmtAddr(b.addr)}（${b.size} 字节），分配于第 ${b.line} 行的 malloc/calloc，程序结束前未 free`,
        b.line,
      );
    }
  }
}

// ---------- 工具函数 ----------
export function fmtAddr(addr: number): string {
  return '0x' + addr.toString(16).padStart(8, '0');
}

export { ParseError, LexError };
