/**
 * The annual inventory from Method Part III, as suggestions.
 *
 * Pre-populating these matters. Sussman & Alter's finding is that people
 * exclude exceptional costs from their budget because each one feels like a
 * one-off, and the documented debiasers are *unpacking the prediction into
 * concrete items* and *explicitly recalling atypical past spending* (F10).
 * A blank "add an irregular" form asks you to recall; a list asks you to
 * recognise, and recognition is the thing that works.
 *
 * Deliberately not seeded as database rows — 24 unchecked suggestions in the
 * ledger would make coverage meaningless on day one. They live here and get
 * picked.
 */

export interface Candidate {
	label: string;
	cadence: 'annual' | 'semiannual' | 'quarterly' | 'monthly' | 'every_n_years';
	cadenceN?: number;
	category: string | null;
	group: string;
}

export const CANDIDATE_GROUPS = [
	'Insurance & fees',
	'Study & work',
	'People & occasions',
	'Devices & home',
	'Health',
	'Travel'
] as const;

export const CANDIDATES: Candidate[] = [
	{ label: 'Insurance premium', cadence: 'annual', category: 'other', group: 'Insurance & fees' },
	{
		label: 'Licence or registration renewal',
		cadence: 'annual',
		category: 'other',
		group: 'Insurance & fees'
	},
	{ label: 'Tax payment', cadence: 'annual', category: 'other', group: 'Insurance & fees' },
	{
		label: 'Professional dues or certification',
		cadence: 'annual',
		category: 'study_work',
		group: 'Insurance & fees'
	},
	{
		label: 'Annual software subscriptions',
		cadence: 'annual',
		category: 'study_work',
		group: 'Insurance & fees'
	},

	{
		label: 'Tuition instalment',
		cadence: 'semiannual',
		category: 'study_work',
		group: 'Study & work'
	},
	{ label: 'Enrolment fee', cadence: 'semiannual', category: 'study_work', group: 'Study & work' },
	{ label: 'Exam fees', cadence: 'annual', category: 'study_work', group: 'Study & work' },
	{
		label: 'Textbooks and materials',
		cadence: 'semiannual',
		category: 'study_work',
		group: 'Study & work'
	},
	{
		label: 'Lab or thesis printing',
		cadence: 'annual',
		category: 'study_work',
		group: 'Study & work'
	},
	{ label: 'Org dues', cadence: 'annual', category: 'social', group: 'Study & work' },

	// "Birthdays" as one line is how the whole category disappears. List the
	// actual people — that is the unpacking debiaser doing its work.
	{
		label: 'Birthdays (list the actual people)',
		cadence: 'annual',
		category: 'social',
		group: 'People & occasions'
	},
	{
		label: 'Holidays and gifts',
		cadence: 'annual',
		category: 'social',
		group: 'People & occasions'
	},
	{ label: 'Weddings', cadence: 'annual', category: 'social', group: 'People & occasions' },
	{
		label: 'Funerals and emergencies',
		cadence: 'annual',
		category: 'social',
		group: 'People & occasions'
	},

	{
		label: 'Phone replacement',
		cadence: 'every_n_years',
		cadenceN: 3,
		category: 'stuff',
		group: 'Devices & home'
	},
	{
		label: 'Laptop replacement',
		cadence: 'every_n_years',
		cadenceN: 4,
		category: 'stuff',
		group: 'Devices & home'
	},
	{ label: 'Home maintenance', cadence: 'annual', category: 'stuff', group: 'Devices & home' },
	{
		label: 'Vehicle maintenance',
		cadence: 'semiannual',
		category: 'transport',
		group: 'Devices & home'
	},
	// The one you cannot name yet is still perfectly predictable in aggregate.
	{
		label: 'One repair you cannot name yet',
		cadence: 'annual',
		category: 'stuff',
		group: 'Devices & home'
	},

	{ label: 'Annual check-up', cadence: 'annual', category: 'health', group: 'Health' },
	{ label: 'Dental', cadence: 'semiannual', category: 'health', group: 'Health' },
	{ label: 'Prescriptions', cadence: 'quarterly', category: 'health', group: 'Health' },
	{ label: 'One unplanned illness', cadence: 'annual', category: 'health', group: 'Health' },

	{ label: 'Trip home', cadence: 'annual', category: 'transport', group: 'Travel' },
	{ label: 'One trip you will want to take', cadence: 'annual', category: 'other', group: 'Travel' }
];
