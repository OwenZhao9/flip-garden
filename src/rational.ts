// Exact rational numbers on BigInt. PnL is computed exactly and rounded once, at the edge.

export type Q = { readonly n: bigint; readonly d: bigint };

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function q(n: bigint, d: bigint = 1n): Q {
  if (d === 0n) throw new Error('rational: zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

export const ZERO: Q = { n: 0n, d: 1n };

export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
export const neg = (a: Q): Q => ({ n: -a.n, d: a.d });
export const cmp = (a: Q, b: Q): number => {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};
export const isZero = (a: Q): boolean => a.n === 0n;
export const sum = (xs: Q[]): Q => xs.reduce(add, ZERO);

// Toward negative infinity (the conservative direction for a gain).
export function floor(a: Q): bigint {
  const t = a.n / a.d;
  return a.n % a.d !== 0n && a.n < 0n ? t - 1n : t;
}

export function ceil(a: Q): bigint {
  const t = a.n / a.d;
  return a.n % a.d !== 0n && a.n > 0n ? t + 1n : t;
}

export const isInteger = (a: Q): boolean => a.d === 1n;

export function toJSON(a: Q): string {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`;
}
