// C 类型系统：基础类型 + 指针 + 数组
export type CBase =
  | 'void'
  | 'char'
  | 'short'
  | 'int'
  | 'long'
  | 'llong'
  | 'float'
  | 'double';

export interface CType {
  base: CBase;
  unsigned: boolean;
  /** 指针层数：0 = 非指针 */
  ptr: number;
  /** 数组维度（仅最外层变量持有），如 int a[3][4] -> [3,4] */
  dims: number[];
}

export const t = (
  base: CBase,
  opts: Partial<Pick<CType, 'unsigned' | 'ptr' | 'dims'>> = {},
): CType => ({
  base,
  unsigned: opts.unsigned ?? false,
  ptr: opts.ptr ?? 0,
  dims: opts.dims ?? [],
});

export const BASE_SIZE: Record<CBase, number> = {
  void: 0,
  char: 1,
  short: 2,
  int: 4,
  long: 8,
  llong: 8,
  float: 4,
  double: 8,
};

export const PTR_SIZE = 8;

export function isPtr(ty: CType): boolean {
  return ty.ptr > 0 && ty.dims.length === 0;
}

export function isArray(ty: CType): boolean {
  return ty.dims.length > 0;
}

export function isFloat(ty: CType): boolean {
  return ty.ptr === 0 && (ty.base === 'float' || ty.base === 'double');
}

export function isInteger(ty: CType): boolean {
  return ty.ptr === 0 && !isFloat(ty) && ty.base !== 'void';
}

/** 数组元素类型 */
export function elemType(ty: CType): CType {
  if (ty.dims.length > 0) {
    return { ...ty, dims: ty.dims.slice(1) };
  }
  if (ty.ptr > 0) {
    return { ...ty, ptr: ty.ptr - 1 };
  }
  return ty;
}

export function sizeOf(ty: CType): number {
  const base = ty.ptr > 0 ? PTR_SIZE : BASE_SIZE[ty.base];
  return ty.dims.reduce((acc, d) => acc * d, base);
}

/** 数组表达式退化为指向首元素的指针 */
export function decay(ty: CType): CType {
  if (ty.dims.length > 0) {
    return { base: ty.base, unsigned: ty.unsigned, ptr: ty.ptr + 1, dims: [] };
  }
  return ty;
}

export function typeName(ty: CType): string {
  const u = ty.unsigned ? 'unsigned ' : '';
  const baseName =
    ty.base === 'llong' ? 'long long' : ty.base === 'void' ? 'void' : ty.base;
  let s = u + baseName;
  for (let i = 0; i < ty.ptr; i++) s += ' *';
  for (const d of ty.dims) s += `[${d}]`;
  return s;
}

export function sameType(a: CType, b: CType): boolean {
  return (
    a.base === b.base &&
    a.ptr === b.ptr &&
    a.dims.length === b.dims.length &&
    a.dims.every((d, i) => d === b.dims[i])
  );
}
