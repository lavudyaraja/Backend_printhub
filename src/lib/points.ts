// Prinsta Points — the unit, the conversion, and the earning rules.
//
// This file is the only place any of these numbers are defined. Prices, orders
// and Razorpay all work in paise (real money); the user's balance works in
// points. Everything that crosses between the two goes through here, and the app
// reads the same values from GET /config rather than hardcoding its own copy —
// a rate that disagrees between client and server shows the user one price and
// charges another.

/** 1 point = 10 paise = ₹0.10. Ten points to the rupee. */
export const PAISE_PER_POINT = 10;

/**
 * Money → points. Floors, so converting never invents value the user didn't pay
 * for; the lost remainder is under one point (10 paise).
 */
export function paiseToPoints(paise: number): number {
  return Math.floor(paise / PAISE_PER_POINT);
}

/** Points → money, for display and for pricing a spend. */
export function pointsToPaise(points: number): number {
  return points * PAISE_PER_POINT;
}

/**
 * What a purchase costs in points. Ceils rather than floors: a 195-paise job has
 * to cost 20 points, not 19, or the half-point difference is given away on every
 * order.
 */
export function priceInPoints(paise: number): number {
  return Math.ceil(paise / PAISE_PER_POINT);
}

/**
 * Bonus points for topping up, best tier first. Bigger top-ups earn a bigger
 * bonus — it cuts the number of gateway fees we pay, and the saving goes back to
 * the user as points.
 */
export interface BonusTier {
  /** Minimum top-up (in paise) that earns this tier. */
  minPaise: number;
  percent: number;
}

export const TOPUP_BONUS_TIERS: readonly BonusTier[] = [
  { minPaise: 100_000, percent: 8 }, // ₹1000 and up
  { minPaise: 50_000, percent: 5 },  // ₹500 – ₹999
  { minPaise: 10_000, percent: 3 },  // ₹100 – ₹499
] as const;

/** The bonus rate a top-up of this size earns (0 when it's below every tier). */
export function bonusPercentFor(paise: number): number {
  return TOPUP_BONUS_TIERS.find((t) => paise >= t.minPaise)?.percent ?? 0;
}

export interface TopupBreakdown {
  /** Points bought outright by the money paid. */
  basePoints: number;
  /** Extra points earned from the tier bonus. */
  bonusPoints: number;
  bonusPercent: number;
  /** basePoints + bonusPoints — what the balance actually goes up by. */
  totalPoints: number;
}

/** Work out exactly what a top-up of `paise` credits. */
export function topupBreakdown(paise: number): TopupBreakdown {
  const basePoints = paiseToPoints(paise);
  const bonusPercent = bonusPercentFor(paise);
  const bonusPoints = Math.floor((basePoints * bonusPercent) / 100);
  return { basePoints, bonusPoints, bonusPercent, totalPoints: basePoints + bonusPoints };
}
