export type PaperId = 'a4' | 'letter' | 'legal' | 'a3' | 'a5';

export interface Paper {
  id: PaperId;
  label: string;
  /** Points, portrait. */
  width: number;
  height: number;
}

export const PAPERS: readonly Paper[] = [
  { id: 'a4', label: 'A4', width: 595.28, height: 841.89 },
  { id: 'letter', label: 'Letter', width: 612, height: 792 },
  { id: 'legal', label: 'Legal', width: 612, height: 1008 },
  { id: 'a3', label: 'A3', width: 841.89, height: 1190.55 },
  { id: 'a5', label: 'A5', width: 419.53, height: 595.28 },
];

export type Orientation = 'portrait' | 'landscape';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const CM = 28.3465;
export const INCH = 72;

export function paper(id: PaperId): Paper {
  return PAPERS.find((p) => p.id === id) ?? PAPERS[0];
}

export function pageSize(id: PaperId, orientation: Orientation): { width: number; height: number } {
  const { width, height } = paper(id);
  return orientation === 'landscape' ? { width: height, height: width } : { width, height };
}

/** Closest named paper to a size taken from a document, so a Letter .docx stays Letter. */
export function nearestPaper(width: number, height: number): PaperId {
  const portrait = Math.min(width, height);
  const landscape = Math.max(width, height);
  let best = PAPERS[0];
  let bestGap = Infinity;
  for (const candidate of PAPERS) {
    const gap = Math.abs(candidate.width - portrait) + Math.abs(candidate.height - landscape);
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best.id;
}

export const uniformMargins = (size: number): Margins => ({
  top: size,
  right: size,
  bottom: size,
  left: size,
});
