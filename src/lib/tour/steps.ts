/**
 * The demo's guided tour, as pure data. The engine in `tour.ts` reads this;
 * nothing here touches the DOM.
 *
 * Targets are `data-tour` values, not CSS selectors, so a renamed class cannot
 * silently break a step. `steps.test.ts` checks every target still appears in
 * the page that owns it.
 */
export type TourPage = '/' | '/review';

export type TourAdvance = 'logged' | 'intent' | 'navigate-review';

export type TourStep =
	| { id: string; kind: 'info'; target: string; title: string; body: string; page: TourPage }
	| {
			id: string;
			kind: 'action';
			target: string;
			title: string;
			body: string;
			page: TourPage;
			advanceOn: TourAdvance;
	  };

export const TOUR_STEPS: readonly TourStep[] = [
	{
		id: 'range',
		kind: 'info',
		target: 'range',
		page: '/',
		title: 'Your daily number',
		body: 'This is how much you can spend today. It is a range, not a balance, on purpose. A balance makes people spend more.'
	},
	{
		id: 'log',
		kind: 'action',
		target: 'entry',
		page: '/',
		advanceOn: 'logged',
		title: 'Log a purchase',
		body: 'Type a purchase, like jollibee 245. Then choose Planned or Unplanned to save it.'
	},
	{
		id: 'ask',
		kind: 'action',
		target: 'entry',
		page: '/',
		advanceOn: 'intent',
		title: 'Try the AI',
		body: 'Now type something that is not a purchase, like trip to tokyo in april, then tap Continue.'
	},
	{
		id: 'laya',
		kind: 'info',
		target: 'intent-result',
		page: '/',
		title: 'Laya picked a form',
		body: 'A small AI model running on this server (Laya) suggests which form you meant. Nothing is saved until you submit.'
	},
	{
		id: 'review-link',
		kind: 'action',
		target: 'nav-review',
		page: '/',
		advanceOn: 'navigate-review',
		title: 'Weekly review',
		body: 'Open Weekly review. This is where you look back at your week.'
	},
	{
		id: 'done',
		kind: 'info',
		target: 'review',
		page: '/review',
		title: 'That is the demo',
		body: 'Thanks for trying Split. Your demo is deleted after 24 hours. You can replay this tour from the banner.'
	}
];
