export const PASTEL_HUES: readonly number[] = [0, 30, 60, 120, 180, 210, 260, 300, 330];

export function randomPastelColor(): string {
  const hue = PASTEL_HUES[Math.floor(Math.random() * PASTEL_HUES.length)];
  return `hsl(${hue}, 70%, 75%)`;
}
