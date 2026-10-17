import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const n = url.searchParams.get('demo');
	return {
		demoOnly: locals.authKind === 'demo',
		notice: n === 'busy' || n === 'too-many' ? n : null
	};
};
