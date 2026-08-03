/**
 * Skill controls, shared by the input handler and every place that shows the
 * player which key to press (HUD counters, skills panel).
 *
 * Space is the only trigger: the sim turns it into a gun shot or hammer swing
 * whenever one is held (and refuses to place bombs until it runs out). A
 * gamepad's A button is the same trigger.
 */
export const SKILL_KEY_LABEL = 'Space/A';
