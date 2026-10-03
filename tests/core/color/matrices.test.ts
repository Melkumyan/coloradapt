import { describe, expect, it } from 'vitest';
import type { Mat3 } from '@core/color';
import { mat3Inverse, mat3Mul, mat3MulVec, vec3Cross, vec3Dot } from '@core/color';

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const A: Mat3 = [2, 0, 1, 1, 3, 2, 1, 1, 4];

describe('mat3 helpers', () => {
  it('multiplies matrix by vector', () => {
    expect(mat3MulVec(A, [1, 2, 3])).toEqual([5, 13, 15]);
  });

  it('multiplies matrices (hand-computed)', () => {
    expect(mat3Mul(A, A)).toEqual([5, 1, 6, 7, 11, 15, 7, 7, 19]);
    expect(mat3Mul(IDENTITY, A)).toEqual(A);
  });

  it('inverts so that A * A^-1 = I', () => {
    const p = mat3Mul(A, mat3Inverse(A));
    p.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY[i]!, 12));
  });

  it('rejects singular matrices', () => {
    expect(() => mat3Inverse([1, 2, 3, 2, 4, 6, 0, 0, 1])).toThrow(RangeError);
  });

  it('computes cross and dot products', () => {
    expect(vec3Cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(vec3Dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
});
