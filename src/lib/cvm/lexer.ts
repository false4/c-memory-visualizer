// 词法分析：把 C 源码切成 token 流
export type TokKind =
  | 'kw'
  | 'ident'
  | 'num'
  | 'char'
  | 'str'
  | 'op'
  | 'eof';

export interface Tok {
  kind: TokKind;
  value: string;
  line: number;
}

export const KEYWORDS = new Set([
  'int', 'char', 'short', 'long', 'float', 'double', 'void',
  'unsigned', 'signed', 'const', 'static', 'if', 'else', 'while',
  'for', 'do', 'return', 'break', 'continue', 'sizeof', 'NULL',
]);

export class LexError extends Error {
  line: number;
  constructor(msg: string, line: number) {
    super(msg);
    this.line = line;
  }
}

const OPS = [
  '>>=', '<<=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '>>', '->',
  '+', '-', '*', '/', '%', '(', ')', '{', '}', '[', ']', ';', ',', '=',
  '<', '>', '!', '~', '&', '|', '^', '?', ':', '.',
];

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const err = (msg: string): never => {
    throw new LexError(msg, line);
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    // 预处理指令（#include / #define ...）：整行跳过
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // 注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      if (i >= n) err('块注释未闭合');
      i += 2;
      continue;
    }

    // 数字
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9.eE+\-]/.test(src[j])) {
          // e+/e- 的符号
          if ((src[j] === '+' || src[j] === '-') && src[j - 1] !== 'e' && src[j - 1] !== 'E') break;
          j++;
        }
      }
      while (j < n && /[uUlLfF]/.test(src[j])) j++; // 后缀
      toks.push({ kind: 'num', value: src.slice(i, j), line });
      i = j;
      continue;
    }

    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      toks.push({ kind: KEYWORDS.has(word) ? 'kw' : 'ident', value: word, line });
      i = j;
      continue;
    }

    // 字符字面量
    if (c === "'") {
      let j = i + 1;
      let val = '';
      if (src[j] === '\\') {
        const esc = src[j + 1];
        const map: Record<string, string> = {
          n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"',
        };
        val = map[esc] ?? esc;
        j += 2;
      } else {
        val = src[j];
        j += 1;
      }
      if (src[j] !== "'") err('字符字面量格式错误');
      toks.push({ kind: 'char', value: val, line });
      i = j + 1;
      continue;
    }

    // 字符串字面量
    if (c === '"') {
      let j = i + 1;
      let val = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          const map: Record<string, string> = {
            n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'",
          };
          val += map[esc] ?? esc;
          j += 2;
        } else {
          if (src[j] === '\n') err('字符串字面量跨行');
          val += src[j];
          j++;
        }
      }
      if (j >= n) err('字符串字面量未闭合');
      toks.push({ kind: 'str', value: val, line });
      i = j + 1;
      continue;
    }

    // 运算符（最长匹配）
    let matched: string | null = null;
    for (const op of OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      toks.push({ kind: 'op', value: matched, line });
      i += matched.length;
      continue;
    }

    err(`无法识别的字符 '${c}'`);
  }

  toks.push({ kind: 'eof', value: '<eof>', line });
  return toks;
}
