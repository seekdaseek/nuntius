/**
 * nuntius design tokens (reference: design/nuntius-mockups-v1.png).
 * Every colour, font and radius in the app and the widget comes from here and
 * nowhere else. The one derived value is a circle's radius, half its size.
 */
export const color = {
  paper: '#F3F4FA',
  card: '#FFFFFF',
  ink: '#151A3D',
  ink2: '#5A6088',
  line: '#E3E5F3',
  track: '#E8EAF6',
  signal: '#4F3BF6',
  signal50: '#ECE9FF',
  heroFrom: '#5B45FF',
  heroTo: '#3A22D9',
  moved: '#19C37D',
  movedInk: '#0B7A4B',
  moved50: '#E2F7EC',
  movedDeep: '#CFF3E0',
  refused: '#F0325C',
  refusedInk: '#A3123A',
  refused50: '#FDE6EC',
  refusedDeep: '#FAD0DB',
  foreign: '#FFA41B',
  foreignInk: '#8A5300',
  foreign50: '#FFF1DA',
  white: '#FFFFFF',
  // Alphas over the signal blue, as in the mockup's CSS.
  glass: 'rgba(255,255,255,0.16)',
  onSignalMuted: 'rgba(255,255,255,0.82)',
  onSignalSoft: 'rgba(255,255,255,0.8)',
  onSignalFaint: 'rgba(255,255,255,0.75)',
  holeDash: 'rgba(255,255,255,0.45)',
  holeToday: 'rgba(255,255,255,0.18)',
  holeShade: 'rgba(21,26,61,0.22)',
  slotPlaceholder: 'rgba(79,59,246,0.45)',
} as const

/** Font family names as registered with useFonts in app/_layout.tsx. */
export const font = {
  display: 'BricolageGrotesque_800ExtraBold',
  regular: 'Figtree_400Regular',
  medium: 'Figtree_500Medium',
  semibold: 'Figtree_600SemiBold',
  bold: 'Figtree_700Bold',
} as const

export const radius = {
  hero: 32,
  widget: 28,
  punch: 24,
  card: 22,
  cta: 20,
  panel: 18,
  field: 16,
  button: 12,
  slot: 12,
  tile: 12,
  stamp: 10,
  slip: 6,
  meter: 6,
  stop: 3,
  chip: 999,
} as const

export const space = { side: 20, cardGap: 12 } as const

/** Tabular figures, so amounts do not jump as they change. */
export const tabular = { fontVariant: ['tabular-nums' as const] }
