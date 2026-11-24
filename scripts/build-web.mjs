// Assemble the static site into _site/: web/ plus the browser-safe core.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
rmSync('_site', { recursive: true, force: true });
mkdirSync('_site', { recursive: true });
cpSync('web', '_site', { recursive: true });
cpSync('src/core.mjs', '_site/core.mjs');
cpSync('src/tiers.mjs', '_site/tiers.mjs');
cpSync('skill.md', '_site/skill.md');
console.log('built _site/');
