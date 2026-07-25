/**
 * Skill controls, shared by the input handler and every place that shows the
 * player which key to press (HUD counters, skills panel).
 *
 * Space is the real trigger: the sim turns it into a gun shot or hammer swing
 * whenever one is held (and refuses to place bombs until it runs out). E/Q stay
 * wired as direct aliases, but the UI advertises Space.
 */
export const SKILL_KEY_LABEL = 'Space';
export const GUN_KEY = 'E';
export const HAMMER_KEY = 'Q';
