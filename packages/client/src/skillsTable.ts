import Phaser from 'phaser';
import { PowerupType } from '@bomberman/shared';
import { SKILL_KEY_LABEL } from './controls';
import { TEX, TEXT_RES, addImage } from './textures';

/** One skill row: powerup type, name, a one-line effect, and its key if it has one. */
const SKILLS: { type: PowerupType; name: string; effect: string; key?: string }[] = [
  { type: PowerupType.ExtraBomb, name: 'Extra Bomb', effect: '+1 bomb at once' },
  { type: PowerupType.BiggerBlast, name: 'Bigger Blast', effect: '+1 blast range' },
  { type: PowerupType.Speed, name: 'Speed', effect: 'move faster' },
  {
    type: PowerupType.Kick,
    name: 'Kick',
    effect: 'walk into a bomb to kick it; slides & blows up on impact (15s)',
  },
  {
    type: PowerupType.Gun,
    name: 'Gun',
    effect: '2 shots — breaks a block, downs a player, sets off a bomb',
    key: SKILL_KEY_LABEL,
  },
  {
    type: PowerupType.Hammer,
    name: 'Hammer',
    effect: '3 swings — smashes the tile ahead, sets off a bomb',
    key: SKILL_KEY_LABEL,
  },
];

const ICON_SIZE = 24;
const ROW_HEIGHT = 26;
const HEADER_GAP = 22;

/**
 * Builds a compact power-up reference table anchored top-left at (x, y).
 * Returns every created object so callers can reposition or destroy them.
 */
export function buildSkillsTable(
  scene: Phaser.Scene,
  x: number,
  y: number,
): Phaser.GameObjects.GameObject[] {
  const objects: Phaser.GameObjects.GameObject[] = [];

  objects.push(
    scene.add.text(x, y, 'SKILLS', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#999999',
      fontStyle: 'bold',
      resolution: TEXT_RES,
    }),
  );

  SKILLS.forEach((skill, i) => {
    const rowY = y + HEADER_GAP + i * ROW_HEIGHT;
    const icon = addImage(scene, x + ICON_SIZE / 2, rowY + ICON_SIZE / 2, TEX.powerup[skill.type]);
    icon.setScale(ICON_SIZE / icon.height);
    objects.push(icon);

    const name = skill.key ? `${skill.name} [${skill.key}]` : skill.name;
    objects.push(
      scene.add.text(x + ICON_SIZE + 8, rowY + ICON_SIZE / 2, `${name}: ${skill.effect}`, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#ffffff',
        resolution: TEXT_RES,
      }).setOrigin(0, 0.5),
    );
  });

  objects.push(
    scene.add.text(
      x,
      y + HEADER_GAP + SKILLS.length * ROW_HEIGHT + 6,
      'Move: arrows / WASD    Bomb: Space (fires the held skill instead)',
      {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#999999',
        resolution: TEXT_RES,
      },
    ),
  );

  return objects;
}
