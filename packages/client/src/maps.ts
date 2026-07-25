import { MAPS } from '@bomberman/shared';

/**
 * Selectable arenas for the menu/lobby toggles: the classic procedural map
 * (empty id, matching the server's `mapId = ''` default) followed by every
 * entry in the shared registry, so new maps show up without touching the UI.
 */
export const MAP_CHOICES: { id: string; name: string }[] = [
  { id: '', name: 'Classic' },
  ...Object.values(MAPS).map((def) => ({ id: def.id, name: def.name })),
];

/** Display name for a map id; unknown ids fall back to the classic label. */
export function mapName(id: string): string {
  return MAP_CHOICES.find((choice) => choice.id === id)?.name ?? MAP_CHOICES[0].name;
}

/** Next choice in the toggle cycle (wraps back to classic). */
export function nextMapId(id: string): string {
  const index = MAP_CHOICES.findIndex((choice) => choice.id === id);
  return MAP_CHOICES[(index + 1) % MAP_CHOICES.length].id;
}
