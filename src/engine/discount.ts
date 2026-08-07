/** Flat continuously-compounded discounting. */
export function makeDf(rate: number): (t: number) => number {
  return (t: number) => Math.exp(-rate * t);
}
