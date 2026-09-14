/**
 * Drizzle schema — Phase 1 subset.
 *
 * The authority for the schema is migrations/*.sql. This file mirrors it so
 * queries are typed; it never creates or alters anything.
 */

import {
	sqliteTable,
	integer,
	real,
	text,
	index,
	uniqueIndex,
	primaryKey
} from 'drizzle-orm/sqlite-core';

/**
 * The person a row belongs to (migration 0008). Named app_user, never
 * `account` — `account` already means a money bucket (Spend, Bills,
 * Irregulars) and reusing it would make every join ambiguous to read.
 * Ships with no authentication: google_sub is nullable until sign-in exists.
 */
export const appUser = sqliteTable('app_user', {
	id: integer('id').primaryKey(),
	googleSub: text('google_sub').unique(),
	email: text('email'),
	displayName: text('display_name'),
	createdAt: text('created_at').notNull(),
	isDemo: integer('is_demo').notNull().default(0),
	deletedAt: text('deleted_at')
});

export const settings = sqliteTable(
	'settings',
	{
		id: integer('id').primaryKey(),
		currencyCode: text('currency_code').notNull(),
		currencySymbol: text('currency_symbol').notNull(),
		minorUnits: integer('minor_units').notNull(),
		roundingStep: integer('rounding_step').notNull(),
		periodKind: text('period_kind', { enum: ['weekly', 'semimonthly', 'monthly'] }).notNull(),
		weekStartsOn: integer('week_starts_on').notNull(),
		haircutPct: integer('haircut_pct').notNull(),
		bandPct: integer('band_pct').notNull(),
		phase: integer('phase').notNull(),
		timezone: text('timezone').notNull(),
		// Phase 3 supersedes this with weeklyTakeHome() over real income rows.
		weeklyTakeHomeMinor: integer('weekly_take_home_minor'),
		createdAt: text('created_at').notNull(),
		// user_id is NOT NULL on every tenanted table so an unowned row cannot
		// exist (migration 0008). `.default(1)` is a backfill device for that
		// migration, not an application default — code should set the owner
		// explicitly once it exists, not lean on this.
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_settings_user').on(t.userId)]
);

export const period = sqliteTable(
	'period',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		startsOn: text('starts_on').notNull(),
		endsOn: text('ends_on').notNull(),
		days: integer('days').notNull(),
		spendAllocMinor: integer('spend_alloc_minor').notNull(),
		dailyAllowanceMinor: integer('daily_allowance_minor').notNull(),
		haircutPctApplied: integer('haircut_pct_applied').notNull(),
		phaseAtOpen: integer('phase_at_open').notNull(),
		supersedesId: integer('supersedes_id'),
		closedAt: text('closed_at'),
		sweptMinor: integer('swept_minor'),
		createdAt: text('created_at').notNull(),
		// Set by closePeriod() when the range has no logged data (Spec §4.1,
		// migration 0007). Excludes the period from trend averages and review
		// comparisons — it is missing data, not a good week.
		isGap: integer('is_gap').notNull().default(0),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [
		uniqueIndex('idx_period_open').on(t.userId, t.startsOn),
		index('idx_period_user').on(t.userId, t.startsOn)
	]
);

export const txn = sqliteTable(
	'txn',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		spentOn: text('spent_on').notNull(),
		amountMinor: integer('amount_minor').notNull(),
		category: text('category').notNull(),
		planned: integer('planned').notNull(),
		note: text('note'),
		periodId: integer('period_id'),
		enteredAt: text('entered_at').notNull(),
		clientUuid: text('client_uuid'),
		// Phase 3 ships the column and the query-layer quarantine; Phase 4 fills
		// it. See metrics.ts — `trip_id IS NULL` lives in one selector.
		tripId: integer('trip_id'),
		amountLocalMinor: integer('amount_local_minor'),
		fxRateUsed: real('fx_rate_used'),
		userId: integer('user_id').notNull().default(1),
		// Migration 0011 (Spec §5.2–§5.9): the typed-entry router.
		label: text('label'),
		source: text('source', { enum: ['cash', 'ewallet', 'card', 'bank', 'unknown'] })
			.notNull()
			.default('unknown'),
		leafId: integer('leaf_id')
	},
	(t) => [
		index('idx_txn_date').on(t.spentOn),
		index('idx_txn_period').on(t.periodId, t.category),
		index('idx_txn_user_date').on(t.userId, t.spentOn)
	]
);

export const account = sqliteTable(
	'account',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		kind: text('kind', {
			enum: ['inflow', 'bills', 'spend', 'irregulars', 'buffer', 'grow']
		}).notNull(),
		institution: text('institution'),
		isCommitted: integer('is_committed').notNull(),
		hasCard: integer('has_card').notNull(),
		balanceMinor: integer('balance_minor').notNull(),
		balanceAsOf: text('balance_as_of'),
		sortOrder: integer('sort_order').notNull(),
		archivedAt: text('archived_at'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_account_user_slug').on(t.userId, t.slug)]
);

export const goal = sqliteTable('goal', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	accountId: integer('account_id').notNull(),
	label: text('label').notNull(),
	targetMinor: integer('target_minor'),
	savedMinor: integer('saved_minor').notNull(),
	imageRef: text('image_ref'),
	targetDate: text('target_date'),
	status: text('status', { enum: ['active', 'reached', 'abandoned'] }).notNull(),
	createdAt: text('created_at').notNull(),
	userId: integer('user_id').notNull().default(1)
});

export const transfer = sqliteTable('transfer', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	movedOn: text('moved_on').notNull(),
	fromAccountId: integer('from_account_id').notNull(),
	toAccountId: integer('to_account_id').notNull(),
	amountMinor: integer('amount_minor').notNull(),
	iouReason: text('iou_reason'),
	iouRepayBy: text('iou_repay_by'),
	repaidAt: text('repaid_at'),
	createdAt: text('created_at').notNull(),
	userId: integer('user_id').notNull().default(1)
});

export const irregular = sqliteTable(
	'irregular',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		label: text('label').notNull(),
		amountMinor: integer('amount_minor').notNull(),
		isEstimate: integer('is_estimate').notNull(),
		cadence: text('cadence', {
			enum: [
				'one_off',
				'weekly',
				'fortnightly',
				'monthly',
				'quarterly',
				'semiannual',
				'annual',
				'every_n_years'
			]
		}).notNull(),
		cadenceN: integer('cadence_n'),
		nextDueOn: text('next_due_on').notNull(),
		category: text('category'),
		paddingPct: integer('padding_pct').notNull(),
		createdAt: text('created_at').notNull(),
		archivedAt: text('archived_at'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [index('idx_irregular_user').on(t.userId)]
);

/**
 * A Bills item with a decision deadline (Spec §158, §267, §374).
 *
 * Not an Irregular: the amount is contractual, so the +25% padding that makes
 * an estimate honest would make this one wrong.
 */
export const subscription = sqliteTable(
	'subscription',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		label: text('label').notNull(),
		vendor: text('vendor'),
		amountMinor: integer('amount_minor').notNull(),
		taxMinor: integer('tax_minor'),
		cadence: text('cadence', {
			enum: ['weekly', 'fortnightly', 'monthly', 'quarterly', 'semiannual', 'annual']
		}).notNull(),
		nextChargeOn: text('next_charge_on').notNull(),
		trialEndsOn: text('trial_ends_on'),
		cancelByOn: text('cancel_by_on'),
		leadDays: integer('lead_days').notNull(),
		alertStage: integer('alert_stage').notNull(),
		alertedAt: text('alerted_at'),
		lastUsedOn: text('last_used_on'),
		category: text('category'),
		note: text('note'),
		createdAt: text('created_at').notNull(),
		cancelledAt: text('cancelled_at'),
		isEssential: integer('is_essential').notNull(),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [index('idx_subscription_user').on(t.userId)]
);

export const irregularInstance = sqliteTable(
	'irregular_instance',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		irregularId: integer('irregular_id').notNull(),
		dueOn: text('due_on').notNull(),
		expectedMinor: integer('expected_minor').notNull(),
		actualMinor: integer('actual_minor'),
		status: text('status', {
			enum: ['projected', 'due', 'settled', 'skipped', 'rescheduled']
		}).notNull(),
		settledOn: text('settled_on'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_ii_unique').on(t.irregularId, t.dueOn)]
);

export const allocation = sqliteTable(
	'allocation',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		periodId: integer('period_id').notNull(),
		accountId: integer('account_id').notNull(),
		amountMinor: integer('amount_minor').notNull(),
		executedAt: text('executed_at'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_allocation_unique').on(t.periodId, t.accountId)]
);

export const trip = sqliteTable(
	'trip',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		label: text('label').notNull(),
		startsOn: text('starts_on').notNull(),
		endsOn: text('ends_on').notNull(),
		tripTz: text('trip_tz').notNull(),
		currencyCode: text('currency_code').notNull(),
		currencySymbol: text('currency_symbol').notNull(),
		// Never inherits settings.minorUnits — see migration 0004.
		localMinorUnits: integer('local_minor_units').notNull(),
		fxRateToHome: real('fx_rate_to_home').notNull(),
		envelopeMinor: integer('envelope_minor').notNull(),
		irregularInstanceId: integer('irregular_instance_id'),
		bufferDrawMinor: integer('buffer_draw_minor').notNull().default(0),
		status: text('status', { enum: ['planned', 'active', 'settled', 'cancelled'] }).notNull(),
		loggedTotalMinor: integer('logged_total_minor'),
		actualMinor: integer('actual_minor'),
		settledOn: text('settled_on'),
		createdAt: text('created_at').notNull(),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_trip_active').on(t.userId, t.status)]
);

export const debt = sqliteTable('debt', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	label: text('label').notNull(),
	balanceMinor: integer('balance_minor').notNull(),
	aprBp: integer('apr_bp').notNull(),
	minPaymentMinor: integer('min_payment_minor').notNull(),
	openedOn: text('opened_on'),
	closedOn: text('closed_on'),
	userId: integer('user_id').notNull().default(1)
});

export const debtPayment = sqliteTable('debt_payment', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	debtId: integer('debt_id').notNull(),
	paidOn: text('paid_on').notNull(),
	amountMinor: integer('amount_minor').notNull(),
	userId: integer('user_id').notNull().default(1)
});

export const rule = sqliteTable('rule', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cue: text('cue').notNull(),
	action: text('action').notNull(),
	category: text('category', {
		enum: ['adherence', 'overspend', 'structural', 'social', 'travel', 'motivation']
	}),
	firedCount: integer('fired_count').notNull().default(0),
	lastFired: text('last_fired'),
	active: integer('active').notNull().default(1),
	sortOrder: integer('sort_order').notNull().default(0),
	userId: integer('user_id').notNull().default(1)
});

export const waitItem = sqliteTable('wait_item', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	label: text('label').notNull(),
	amountMinor: integer('amount_minor'),
	addedAt: text('added_at').notNull(),
	ripeAt: text('ripe_at').notNull(),
	outcome: text('outcome', { enum: ['bought', 'dropped', 'expired'] }),
	resolvedAt: text('resolved_at'),
	userId: integer('user_id').notNull().default(1)
});

export const phaseChange = sqliteTable(
	'phase_change',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		fromPhase: integer('from_phase').notNull(),
		toPhase: integer('to_phase').notNull(),
		proposedOn: text('proposed_on').notNull(),
		rationale: text('rationale').notNull(),
		acceptedAt: text('accepted_at'),
		declinedAt: text('declined_at'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_phase_change_unique').on(t.userId, t.fromPhase, t.toPhase, t.proposedOn)]
);

export const logDay = sqliteTable(
	'log_day',
	{
		loggedOn: text('logged_on').notNull(),
		entryCount: integer('entry_count').notNull(),
		isCatchup: integer('is_catchup').notNull(),
		closedAt: text('closed_at').notNull(),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.loggedOn] }),
		index('idx_log_day_user').on(t.userId, t.loggedOn)
	]
);

export const review = sqliteTable(
	'review',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		kind: text('kind', { enum: ['weekly', 'monthly', 'quarterly', 'annual'] }).notNull(),
		periodLabel: text('period_label').notNull(),
		startsOn: text('starts_on').notNull(),
		endsOn: text('ends_on').notNull(),
		completedAt: text('completed_at'),

		spendBalanceMinor: integer('spend_balance_minor'),
		irregularsMinor: integer('irregulars_minor'),
		bufferMinor: integer('buffer_minor'),
		debtTotalMinor: integer('debt_total_minor'),

		totalSpentMinor: integer('total_spent_minor'),
		unplannedRatioBp: integer('unplanned_ratio_bp'),
		bufferWeeksX100: integer('buffer_weeks_x100'),
		coverageRatioBp: integer('coverage_ratio_bp'),
		saveRateBp: integer('save_rate_bp'),
		logAdherenceBp: integer('log_adherence_bp'),
		streakAtClose: integer('streak_at_close'),

		summaryLine: text('summary_line'),
		sharedAt: text('shared_at'),
		notes: text('notes'),
		createdAt: text('created_at').notNull(),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [
		uniqueIndex('idx_review_label').on(t.userId, t.kind, t.periodLabel),
		index('idx_review_window').on(t.userId, t.kind, t.endsOn)
	]
);

export const reviewStep = sqliteTable(
	'review_step',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		reviewId: integer('review_id').notNull(),
		stepKey: text('step_key').notNull(),
		doneAt: text('done_at'),
		payload: text('payload'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [uniqueIndex('idx_review_step').on(t.reviewId, t.stepKey)]
);

export const jobRun = sqliteTable(
	'job_run',
	{
		jobKey: text('job_key').notNull(),
		ranFor: text('ran_for').notNull(),
		ranAt: text('ran_at').notNull(),
		detail: text('detail'),
		userId: integer('user_id').notNull().default(1)
	},
	(t) => [primaryKey({ columns: [t.userId, t.jobKey, t.ranFor] })]
);

/**
 * A signed-in session (migration 0009, Spec §3.3). Deliberately opaque and
 * random — `id` is 32 bytes of crypto.randomBytes as hex, never anything
 * derived or guessable — so revoking one is a DELETE, not a key rotation.
 * `userId` has no `.default(1)`: unlike the twenty tenanted tables backfilled
 * by migration 0008, no session existed before this one, so there is no
 * owner-1 default to carry forward.
 */
export const session = sqliteTable(
	'session',
	{
		id: text('id').primaryKey(),
		userId: integer('user_id').notNull(),
		createdAt: text('created_at').notNull(),
		expiresAt: text('expires_at').notNull()
	},
	(t) => [index('idx_session_user').on(t.userId)]
);

/**
 * A user-grown leaf under exactly one of the eight fixed roots (migration
 * 0011, Spec §5.5). Roots never change and carry no budget, target or limit;
 * neither does a leaf — invariant 4's rule is absolute at both levels. No
 * `.default(1)` on `userId`: like `session` (migration 0009), this is a
 * brand-new table with no pre-existing rows to backfill.
 */
export const categoryLeaf = sqliteTable(
	'category_leaf',
	{
		id: integer('id').primaryKey(),
		userId: integer('user_id').notNull(),
		root: text('root', {
			enum: [
				'food_in',
				'food_out',
				'transport',
				'study_work',
				'health',
				'social',
				'stuff',
				'other'
			]
		}).notNull(),
		name: text('name').notNull(),
		createdAt: text('created_at').notNull()
	},
	(t) => [
		uniqueIndex('idx_category_leaf_unique').on(t.userId, t.root, t.name),
		index('idx_category_leaf_user').on(t.userId, t.root)
	]
);

/**
 * `typed -> (english, root, leaf)`, per user, written when the user answers a
 * question (migration 0011, Spec §5.7). One user teaching "kape" does not
 * teach it for everyone — the seed dictionary is shared, this table is not.
 */
export const labelMap = sqliteTable(
	'label_map',
	{
		id: integer('id').primaryKey(),
		userId: integer('user_id').notNull(),
		typed: text('typed').notNull(),
		english: text('english').notNull(),
		root: text('root', {
			enum: [
				'food_in',
				'food_out',
				'transport',
				'study_work',
				'health',
				'social',
				'stuff',
				'other'
			]
		}).notNull(),
		leafId: integer('leaf_id')
	},
	(t) => [uniqueIndex('idx_label_map_unique').on(t.userId, t.typed), index('idx_label_map_user').on(t.userId)]
);

export type AppUser = typeof appUser.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Period = typeof period.$inferSelect;
export type Txn = typeof txn.$inferSelect;
export type Review = typeof review.$inferSelect;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Goal = typeof goal.$inferSelect;
export type Transfer = typeof transfer.$inferSelect;
export type Irregular = typeof irregular.$inferSelect;
export type IrregularInstance = typeof irregularInstance.$inferSelect;
export type Allocation = typeof allocation.$inferSelect;
export type PhaseChange = typeof phaseChange.$inferSelect;
export type Trip = typeof trip.$inferSelect;
export type Debt = typeof debt.$inferSelect;
export type Rule = typeof rule.$inferSelect;
export type WaitItem = typeof waitItem.$inferSelect;
export type ReviewStep = typeof reviewStep.$inferSelect;
export type CategoryLeaf = typeof categoryLeaf.$inferSelect;
export type LabelMap = typeof labelMap.$inferSelect;
