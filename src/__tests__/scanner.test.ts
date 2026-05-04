import { describe, it, expect } from 'vitest'
import { calculateScore } from '../scanner'

describe('calculateScore', () => {
  it('returns 100 when no violations', () => {
    expect(calculateScore(0, 0, 0, 0)).toBe(100)
  })

  it('deducts 20 per critical violation', () => {
    expect(calculateScore(1, 0, 0, 0)).toBe(80)
    expect(calculateScore(2, 0, 0, 0)).toBe(60)
    expect(calculateScore(5, 0, 0, 0)).toBe(0)
  })

  it('deducts 10 per serious violation', () => {
    expect(calculateScore(0, 1, 0, 0)).toBe(90)
    expect(calculateScore(0, 3, 0, 0)).toBe(70)
  })

  it('deducts 5 per moderate violation', () => {
    expect(calculateScore(0, 0, 1, 0)).toBe(95)
    expect(calculateScore(0, 0, 4, 0)).toBe(80)
  })

  it('deducts 2 per minor violation', () => {
    expect(calculateScore(0, 0, 0, 1)).toBe(98)
    expect(calculateScore(0, 0, 0, 5)).toBe(90)
  })

  it('combines all violation types correctly', () => {
    // 1*20 + 2*10 + 3*5 + 4*2 = 20 + 20 + 15 + 8 = 63 → 37
    expect(calculateScore(1, 2, 3, 4)).toBe(37)
  })

  it('never goes below 0', () => {
    expect(calculateScore(10, 10, 10, 10)).toBe(0)
    expect(calculateScore(100, 0, 0, 0)).toBe(0)
  })

  it('returns integer', () => {
    const score = calculateScore(1, 1, 1, 1)
    expect(Number.isInteger(score)).toBe(true)
  })
})
