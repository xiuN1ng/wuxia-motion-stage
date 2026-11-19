import './combat.css';
import { createCombatArena } from './CombatArenaApp.js';

const rootEl = document.getElementById('combat-root');
const arena = createCombatArena(rootEl, {
  embedded: false,
  autoActive: true,
  exposeGlobal: true,
});

arena.mount().catch((err) => {
  console.error('[CombatArena] Mount failed:', err);
});
