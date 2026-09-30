/**
 * nuntius design tokens (BRIEF-C1 part C; reference: design/nuntius-mockups-v1.png).
 * Every colour, font and radius in the app comes from here and nowhere else.
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
  glass: 'rgba(255,255,255,0.16)',
  onSignalMuted: 'rgba(255,255,255,0.82)',
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
  card: 22,
  cta: 20,
  field: 16,
  button: 12,
  slip: 6,
  meter: 6,
  chip: 999,
} as const

export const space = { side: 20, cardGap: 12 } as const

/** Tabular figures, so amounts do not jump as they change. */
export const tabular = { fontVariant: ['tabular-nums' as const] }
