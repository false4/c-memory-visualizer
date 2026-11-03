// 语法分析：递归下降，产出 AST
import { t, type CBase, type CType } from './ctypes';
import { tokenize, type Tok, LexError } from './lexer';

// ---------- AST ----------
export type Expr =
  | { kind: 'num'; value: number; line: number }
  | { kind: 'char'; value: string; line: number }
  | { kind: 'str'; value: string; line: number }
  | { kind: 'var'; name: string; line: number }
  | { kind: 'bin'; op: string; l: Expr; r: Expr; line: number }
  | { kind: 'un'; op: string; expr: Expr; prefix: boolean; line: number }
  | { kind: 'assign'; op: string; target: Expr; value: Expr; line: number }
  | { kind: 'call'; name: string; args: Expr[]; line: number }
  | { kind: 'index'; arr: Expr; index: Expr; line: number }
  | { kind: 'sizeofType'; cType: CType; line: number }
  | { kind: 'sizeofExpr'; expr: Expr; line: number }
  | { kind: 'cast'; cType: CType; expr: Expr; line: number };

export type Stmt =
  | { kind: 'decl'; cType: CType; name: string; dims: number[]; init: Expr | Expr[] | null; line: number }
  | { kind: 'expr'; expr: Expr; line: number }
  | { kind: 'if'; cond: Expr; then: Stmt; else: Stmt | null; line: number }
  | { kind: 'while'; cond: Expr; body: Stmt; line: number }
  | { kind: 'doWhile'; cond: Expr; body: Stmt; line: number }
  | { kind: 'for'; init: Stmt | null; cond: Expr | null; post: Expr | null; body: Stmt; line: number }
  | { kind: 'return'; expr: Expr | null; line: number }
  | { kind: 'break'; line: number }
  | { kind: 'continue'; line: number }
  | { kind: 'block'; stmts: Stmt[]; line: number }
  | { kind: 'empty'; line: number };

export interface FuncDef {
  name: string;
  retType: CType;
  params: { name: string; cType: CType }[];
  body: Stmt;
  line: number;
}

export interface Program {
  globals: Stmt[]; // 全部是 decl
  funcs: FuncDef[];
}

export class ParseError extends Error {
  line: number;
  constructor(msg: string, line: number) {
    super(msg);
    this.line = line;
  }
}

// ---------- Parser ----------
class Parser {
  private toks: Tok[];
  private pos = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)];
  }
  private next(): Tok {
    return this.toks[this.pos++];
  }
  private atEof(): boolean {
    return this.peek().kind === 'eof';
  }
  private isOp(v: string): boolean {
    const tk = this.peek();
    return tk.kind === 'op' && tk.value === v;
  }
  private isKw(v: string): boolean {
    const tk = this.peek();
    return tk.kind === 'kw' && tk.value === v;
  }
  private expectOp(v: string): Tok {
    const tk = this.peek();
    if (tk.kind !== 'op' || tk.value !== v) {
      throw new ParseError(`第 ${tk.line} 行：期望 '${v}'，但遇到 '${tk.value}'`, tk.line);
    }
    return this.next();
  }
  private expectIdent(): Tok {
    const tk = this.peek();
    if (tk.kind !== 'ident') {
      throw new ParseError(`第 ${tk.line} 行：期望标识符，但遇到 '${tk.value}'`, tk.line);
    }
    return this.next();
  }
  private err(msg: string): never {
    throw new ParseError(`第 ${this.peek().line} 行：${msg}`, this.peek().line);
  }

  /** 解析声明说明符：const/static/unsigned/signed + 基础类型 + * */
  private parseDeclSpec(): CType | null {
    let unsigned = false;
    let ptr = 0;
    let consumed = false;
    // 存储类/限定符（跳过）
    while (this.isKw('const') || this.isKw('static') || this.isKw('signed')) {
      this.next();
      consumed = true;
    }
    if (this.isKw('unsigned')) { unsigned = true; this.next(); consumed = true; }
    let base: CBase | null = null;
    if (this.isKw('char')) { base = 'char'; this.next(); }
    else if (this.isKw('short')) { base = 'short'; this.next(); }
    else if (this.isKw('int')) { base = 'int'; this.next(); }
    else if (this.isKw('float')) { base = 'float'; this.next(); }
    else if (this.isKw('double')) { base = 'double'; this.next(); }
    else if (this.isKw('void')) { base = 'void'; this.next(); }
    else if (this.isKw('long')) {
      this.next();
      if (this.isKw('long')) { base = 'llong'; this.next(); }
      else base = 'long';
    }
    if (!base) {
      if (consumed && unsigned) base = 'int';
      else if (!consumed) return null;
      else this.err('无法识别的类型');
    }
    // long int / short int / unsigned int
    if ((base === 'long' || base === 'short' || base === 'llong' || unsigned) && this.isKw('int')) {
      this.next();
    }
    while (this.isOp('*')) { this.next(); ptr++; }
    while (this.isKw('const')) this.next();
    return t(base!, { unsigned, ptr });
  }

  parseProgram(): Program {
    const globals: Stmt[] = [];
    const funcs: FuncDef[] = [];
    while (!this.atEof()) {
      const spec = this.parseDeclSpec();
      if (!spec) this.err(`意外的 '${this.peek().value}'（期望类型或函数定义）`);
      const nameTk = this.expectIdent();
      if (this.isOp('(')) {
        // 函数定义
        this.next();
        const params: { name: string; cType: CType }[] = [];
        if (!this.isOp(')')) {
          if (this.isKw('void') && this.peek(1).value === ')') {
            this.next();
          } else {
            do {
              if (this.isOp(',')) this.next();
              const ps = this.parseDeclSpec();
              if (!ps) this.err('参数类型无效');
              const pn = this.expectIdent();
              // 数组参数退化为指针：int a[] -> int*
              let ptype = ps;
              if (this.isOp('[')) {
                this.next();
                if (this.peek().kind === 'num') this.next();
                this.expectOp(']');
                ptype = { ...ps, ptr: ps.ptr + 1 };
              }
              params.push({ name: pn.value, cType: ptype });
            } while (this.isOp(','));
          }
        }
        this.expectOp(')');
        const body = this.parseBlock();
        funcs.push({ name: nameTk.value, retType: spec, params, body, line: nameTk.line });
      } else {
        // 全局变量（可能逗号声明多个：int a, b=2;）
        let ctype = spec;
        let name = nameTk.value;
        let line = nameTk.line;
        for (;;) {
          const dims: number[] = [];
          while (this.isOp('[')) {
            this.next();
            const numTk = this.next();
            if (numTk.kind !== 'num') this.err('数组长度必须是数字');
            dims.push(parseInt(numTk.value, 10));
            this.expectOp(']');
          }
          let init: Expr | Expr[] | null = null;
          if (this.isOp('=')) {
            this.next();
            init = this.parseInitializer();
          }
          globals.push({ kind: 'decl', cType: { ...ctype, dims }, name, dims, init, line });
          if (this.isOp(',')) {
            this.next();
            // 逗号后的声明符可能带 *：int a, *p;
            let extraPtr = 0;
            while (this.isOp('*')) { this.next(); extraPtr++; }
            const nt = this.expectIdent();
            ctype = { ...spec, ptr: spec.ptr + extraPtr };
            name = nt.value;
            line = nt.line;
            continue;
          }
          break;
        }
        this.expectOp(';');
      }
    }
    return { globals, funcs };
  }

  private parseInitializer(): Expr | Expr[] {
    if (this.isOp('{')) {
      this.next();
      const items: Expr[] = [];
      if (!this.isOp('}')) {
        do {
          if (this.isOp(',')) this.next();
          if (this.isOp('}')) break;
          const it = this.parseInitializer();
          if (Array.isArray(it)) items.push(...it);
          else items.push(it);
        } while (this.isOp(','));
      }
      this.expectOp('}');
      return items;
    }
    return this.parseExpr();
  }

  parseBlock(): Stmt {
    const open = this.expectOp('{');
    const stmts: Stmt[] = [];
    while (!this.isOp('}')) {
      if (this.atEof()) this.err("缺少 '}'");
      stmts.push(this.parseStmt());
    }
    this.next();
    return { kind: 'block', stmts, line: open.line };
  }

  parseStmt(): Stmt {
    const tk = this.peek();

    if (tk.kind === 'op' && tk.value === '{') return this.parseBlock();
    if (tk.kind === 'op' && tk.value === ';') { this.next(); return { kind: 'empty', line: tk.line }; }

    if (tk.kind === 'kw') {
      switch (tk.value) {
        case 'if': {
          this.next();
          this.expectOp('(');
          const cond = this.parseExpr();
          this.expectOp(')');
          const then = this.parseStmt();
          let elseS: Stmt | null = null;
          if (this.isKw('else')) { this.next(); elseS = this.parseStmt(); }
          return { kind: 'if', cond, then, else: elseS, line: tk.line };
        }
        case 'while': {
          this.next();
          this.expectOp('(');
          const cond = this.parseExpr();
          this.expectOp(')');
          const body = this.parseStmt();
          return { kind: 'while', cond, body, line: tk.line };
        }
        case 'do': {
          this.next();
          const body = this.parseStmt();
          if (!this.isKw('while')) this.err('do 后面需要 while');
          this.next();
          this.expectOp('(');
          const cond = this.parseExpr();
          this.expectOp(')');
          this.expectOp(';');
          return { kind: 'doWhile', cond, body, line: tk.line };
        }
        case 'for': {
          this.next();
          this.expectOp('(');
          let init: Stmt | null = null;
          if (!this.isOp(';')) {
            const spec = this.parseDeclSpec();
            if (spec) {
              init = this.parseDeclRest(spec);
            } else {
              const e = this.parseExpr();
              this.expectOp(';');
              init = { kind: 'expr', expr: e, line: e.line };
            }
          } else { this.next(); }
          let cond: Expr | null = null;
          if (!this.isOp(';')) cond = this.parseExpr();
          this.expectOp(';');
          let post: Expr | null = null;
          if (!this.isOp(')')) post = this.parseExpr();
          this.expectOp(')');
          const body = this.parseStmt();
          return { kind: 'for', init, cond, post, body, line: tk.line };
        }
        case 'return': {
          this.next();
          let expr: Expr | null = null;
          if (!this.isOp(';')) expr = this.parseExpr();
          this.expectOp(';');
          return { kind: 'return', expr, line: tk.line };
        }
        case 'break': this.next(); this.expectOp(';'); return { kind: 'break', line: tk.line };
        case 'continue': this.next(); this.expectOp(';'); return { kind: 'continue', line: tk.line };
        default:
          // 可能是声明
          {
            const spec = this.parseDeclSpec();
            if (spec) return this.parseDeclRest(spec);
          }
      }
    }

    // 表达式语句
    const e = this.parseExpr();
    this.expectOp(';');
    return { kind: 'expr', expr: e, line: tk.line };
  }

  /** 已解析 decl-spec，继续解析变量名 / 数组 / 初始化，直到分号 */
  private parseDeclRest(spec: CType): Stmt {
    let ctype = spec;
    const nameTk = this.expectIdent();
    let name = nameTk.value;
    let line = nameTk.line;
    let first: Stmt | null = null;
    for (;;) {
      const dims: number[] = [];
      while (this.isOp('[')) {
        this.next();
        let d = 0;
        if (this.peek().kind === 'num') {
          d = parseInt(this.next().value, 10);
        }
        this.expectOp(']');
        dims.push(d);
      }
      let init: Expr | Expr[] | null = null;
      if (this.isOp('=')) {
        this.next();
        init = this.parseInitializer();
      }
      const decl: Stmt = { kind: 'decl', cType: { ...ctype, dims }, name, dims, init, line };
      if (!first) first = decl;
      else {
        // int a = 1, b = 2; -> block
        if (first.kind !== 'block') first = { kind: 'block', stmts: [first], line: first.line };
        (first as { stmts: Stmt[] }).stmts.push(decl);
      }
      if (this.isOp(',')) {
        this.next();
        let extraPtr = 0;
        while (this.isOp('*')) { this.next(); extraPtr++; }
        const nt = this.expectIdent();
        ctype = { ...spec, ptr: spec.ptr + extraPtr };
        name = nt.value;
        line = nt.line;
        continue;
      }
      break;
    }
    this.expectOp(';');
    return first!;
  }

  // ---------- 表达式 ----------
  parseExpr(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const l = this.parseLogicalOr();
    const tk = this.peek();
    if (tk.kind === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(tk.value)) {
      this.next();
      const r = this.parseAssign();
      return { kind: 'assign', op: tk.value, target: l, value: r, line: tk.line };
    }
    return l;
  }

  private binLevel(next: () => Expr, ops: string[]): () => Expr {
    return () => {
      let l = next();
      for (;;) {
        const tk = this.peek();
        if (tk.kind === 'op' && ops.includes(tk.value)) {
          this.next();
          const r = next();
          l = { kind: 'bin', op: tk.value, l, r, line: tk.line };
        } else return l;
      }
    };
  }

  private parseLogicalOr = () => this.binLevel(() => this.parseLogicalAnd(), ['||'])();
  private parseLogicalAnd = () => this.binLevel(() => this.parseBitOr(), ['&&'])();
  private parseBitOr = () => this.binLevel(() => this.parseBitXor(), ['|'])();
  private parseBitXor = () => this.binLevel(() => this.parseBitAnd(), ['^'])();
  private parseBitAnd = () => this.binLevel(() => this.parseEquality(), ['&'])();
  private parseEquality = () => this.binLevel(() => this.parseRelational(), ['==', '!='])();
  private parseRelational = () => this.binLevel(() => this.parseShift(), ['<', '>', '<=', '>='])();
  private parseShift = () => this.binLevel(() => this.parseAdditive(), ['<<', '>>'])();
  private parseAdditive = () => this.binLevel(() => this.parseMultiplicative(), ['+', '-'])();
  private parseMultiplicative = () => this.binLevel(() => this.parseUnary(), ['*', '/', '%'])();

  private parseUnary(): Expr {
    const tk = this.peek();
    if (tk.kind === 'op') {
      if (['-', '!', '~', '*', '&', '++', '--'].includes(tk.value)) {
        this.next();
        const expr = this.parseUnary();
        return { kind: 'un', op: tk.value, expr, prefix: true, line: tk.line };
      }
      if (tk.value === '(') {
        // 可能是强转：(int)x / (int*)malloc(...)
        const save = this.pos;
        this.next();
        const spec = this.parseDeclSpec();
        if (spec && this.isOp(')')) {
          this.next();
          const expr = this.parseUnary();
          return { kind: 'cast', cType: spec, expr, line: tk.line };
        }
        this.pos = save; // 回退，按括号表达式处理
      }
    }
    if (tk.kind === 'kw' && tk.value === 'sizeof') {
      this.next();
      this.expectOp('(');
      const save = this.pos;
      const spec = this.parseDeclSpec();
      if (spec && this.isOp(')')) {
        this.next();
        return { kind: 'sizeofType', cType: spec, line: tk.line };
      }
      this.pos = save;
      const expr = this.parseUnary();
      this.expectOp(')');
      return { kind: 'sizeofExpr', expr, line: tk.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const tk = this.peek();
      if (tk.kind === 'op' && tk.value === '(') {
        if (e.kind !== 'var') this.err('只有函数名可以被调用');
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          do {
            if (this.isOp(',')) this.next();
            args.push(this.parseAssign());
          } while (this.isOp(','));
        }
        this.expectOp(')');
        e = { kind: 'call', name: e.name, args, line: tk.line };
      } else if (tk.kind === 'op' && tk.value === '[') {
        this.next();
        const idx = this.parseExpr();
        this.expectOp(']');
        e = { kind: 'index', arr: e, index: idx, line: tk.line };
      } else if (tk.kind === 'op' && (tk.value === '++' || tk.value === '--')) {
        this.next();
        e = { kind: 'un', op: tk.value, expr: e, prefix: false, line: tk.line };
      } else return e;
    }
  }

  private parsePrimary(): Expr {
    const tk = this.next();
    if (tk.kind === 'num') {
      const raw = tk.value.replace(/[uUlLfF]+$/, '');
      const value = raw.startsWith('0x') || raw.startsWith('0X')
        ? parseInt(raw, 16)
        : parseFloat(raw);
      if (Number.isNaN(value)) throw new ParseError(`第 ${tk.line} 行：数字 '${tk.value}' 无法解析`, tk.line);
      return { kind: 'num', value, line: tk.line };
    }
    if (tk.kind === 'char') return { kind: 'char', value: tk.value, line: tk.line };
    if (tk.kind === 'str') return { kind: 'str', value: tk.value, line: tk.line };
    if (tk.kind === 'ident') return { kind: 'var', name: tk.value, line: tk.line };
    if (tk.kind === 'kw' && tk.value === 'NULL') return { kind: 'num', value: 0, line: tk.line };
    if (tk.kind === 'op' && tk.value === '(') {
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    throw new ParseError(`第 ${tk.line} 行：意外的 '${tk.value}'`, tk.line);
  }
}

export function parse(src: string): Program {
  return new Parser(src).parseProgram();
}

export { LexError };
