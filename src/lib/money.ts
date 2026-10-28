/**
 * Money is stored as an integer count of $0.1M (DM 0.3): 234 means $23.4M and
 * 1000 means $100M. All arithmetic and formatting stays in integers so that
 * values never drift.
 */
export type MoneyUnits = number;

/** Thrown by parseMoney when the text is not a valid money string. */
export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

const MONEY_TEXT = /^\$(\d+)(?:\.(\d))?M$/;

/** Parses "$23.4M", "$100M" or "$3.0M" into units. Throws on anything else. */
export function parseMoney(text: string): MoneyUnits {
  const match = MONEY_TEXT.exec(text);
  if (match === null) {
    throw new MoneyFormatError(
      `Invalid money "${text}": expected like "$23.4M"`,
    );
  }
  const [, whole = "0", tenth = "0"] = match;
  const units = Number(whole) * 10 + Number(tenth);
  if (!Number.isSafeInteger(units)) {
    throw new MoneyFormatError(`Invalid money "${text}": amount is too large`);
  }
  return units;
}

/** Formats units as "$23.4M". Set trimWhole to show "$100M" for whole millions. */
export function formatMoney(
  units: MoneyUnits,
  opts?: { trimWhole?: boolean },
): string {
  assertInteger(units);
  if (units < 0) {
    throw new RangeError(`Money cannot be negative: ${units}`);
  }
  const { whole, tenth } = splitTenths(units);
  if (opts?.trimWhole === true && tenth === 0) {
    return `$${whole}M`;
  }
  return `$${whole}.${tenth}M`;
}

/**
 * Formats a change as a signed delta with no currency symbol: "▲0.2" for a
 * rise, "▼0.1" for a fall, "■0.0" for no change.
 */
export function formatDelta(units: MoneyUnits): string {
  assertInteger(units);
  let symbol = "■";
  if (units > 0) {
    symbol = "▲";
  } else if (units < 0) {
    symbol = "▼";
  }
  const { whole, tenth } = splitTenths(Math.abs(units));
  return `${symbol}${whole}.${tenth}`;
}

function assertInteger(units: number): void {
  if (!Number.isInteger(units)) {
    throw new RangeError(`Money units must be an integer: ${units}`);
  }
}

/** Splits a non-negative integer of tenths into whole millions and the tenth digit. */
function splitTenths(units: number): { whole: number; tenth: number } {
  const tenth = units % 10;
  return { whole: (units - tenth) / 10, tenth };
}
