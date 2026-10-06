/**
 * Today must never again print a shell command. The fallback it replaced told
 * a signed-in stranger to run `npm run period:open`, naming a script hardcoded
 * to `WHERE id = 1` — the owner's tenant.
 */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

it('the Today screen contains no shell instructions', () => {
	const src = readFileSync('src/routes/+page.svelte', 'utf8');
	expect(src).not.toMatch(/npm run period:open/);
	expect(src).not.toMatch(/docker compose exec/);
	expect(src).not.toMatch(/scripts\/init\.js/);
});
