<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import LogOverlay from '$lib/components/LogOverlay.svelte';
	import { CATEGORIES, categoryLabel, type CategoryKey } from '$lib/categories';
	import { LogEntry, logSubmit, type EntrySnapshot } from '$lib/log-entry.svelte';
	import { formatMoney, parseMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const view = $derived(data.view);

	const DESKTOP = '(min-width: 48rem)';

	/*
	 * Two shells, one entry. Mobile keeps the resident form (§8.0b.4 — the log
	 * happens in bed, one-handed); desktop summons an overlay so nothing
	 * competes with the hero (§8.0b.2).
	 *
	 * Neither defaults the planned/unplanned flag. A default makes the unplanned
	 * ratio mean something different depending on which device you were holding,
	 * and that ratio is the direct measure of exceptional-expense blindness
	 * losing its grip on you (F10) — a metric with two definitions measures
	 * nothing. It costs nothing on desktop either, because P and U *are* the
	 * save action; all that goes away is bare Enter recording a judgement you
	 * never made.
	 */
	const mobileEntry = new LogEntry('');
	const desktopEntry = new LogEntry('');

	let nothingForm = $state<HTMLFormElement | undefined>();
	let overlayOpen = $state(false);
	let isDesktop = $state(false);
	let toast = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function describe(s: EntrySnapshot): string {
		const minorUnits = view!.trip ? view!.trip.currency.minorUnits : view!.currency.minorUnits;
		const symbol = view!.trip ? view!.trip.currency.symbol : view!.currency.symbol;
		const parsed = parseMoney(s.amount, minorUnits);
		const amountText =
			parsed === null ? s.amount : formatMoney(parsed, { minorUnits, symbol }).replace(/\.00$/, '');
		return `Logged ${amountText} · ${categoryLabel(s.category as CategoryKey)} · ${
			s.planned === '1' ? 'planned' : 'unplanned'
		}`;
	}

	function onSaved(s: EntrySnapshot) {
		overlayOpen = false;
		toast = describe(s);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 2400);
	}

	onMount(() => {
		const mq = window.matchMedia(DESKTOP);
		isDesktop = mq.matches;
		const onChange = (e: MediaQueryListEvent) => {
			isDesktop = e.matches;
			if (!e.matches) overlayOpen = false;
		};
		mq.addEventListener('change', onChange);

		function onKeydown(event: KeyboardEvent) {
			// Asked live rather than read from `isDesktop`: a stale flag would
			// summon a keyboard overlay on a phone, which has no keyboard to
			// dismiss it with.
			if (!window.matchMedia(DESKTOP).matches || overlayOpen || !view) return;

			// ⌘K / Ctrl+K opens it empty.
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				desktopEntry.reset();
				overlayOpen = true;
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey) return;

			// Typing anywhere that is not already a field opens it with the digit
			// already in the amount. This is the trigger that makes it feel
			// instant — without it, ⌘K is just a shortcut for a button.
			const target = event.target as HTMLElement | null;
			const typing =
				target &&
				(target.tagName === 'INPUT' ||
					target.tagName === 'TEXTAREA' ||
					target.tagName === 'SELECT' ||
					target.isContentEditable);
			if (typing) return;

			// N closes the day with nothing on it. Idempotent — closeLogDay upserts,
			// so a stray press cannot double-file or break a streak.
			if (event.key.toLowerCase() === 'n' && view && !view.dayClosed) {
				event.preventDefault();
				nothingForm?.requestSubmit();
				return;
			}

			if (/^[0-9]$/.test(event.key)) {
				event.preventDefault();
				desktopEntry.reset();
				desktopEntry.amount = event.key;
				overlayOpen = true;
			}
		}

		window.addEventListener('keydown', onKeydown);
		return () => {
			mq.removeEventListener('change', onChange);
			window.removeEventListener('keydown', onKeydown);
			clearTimeout(toastTimer);
		};
	});

	function money(minor: number): string {
		return formatMoney(minor, {
			minorUnits: view!.currency.minorUnits,
			symbol: view!.currency.symbol
		});
	}

	/** Amounts in the trip's own currency, at the trip's own scale. */
	function local(minor: number): string {
		const t = view!.trip!;
		return formatMoney(minor, { minorUnits: t.currency.minorUnits, symbol: t.currency.symbol });
	}

	// The live home-currency figure under the keypad is not a convenience — it
	// is the countermeasure. Foreign currency weakens the pain of paying, and
	// the conversion is the friction the unfamiliar notes removed (F11).
	const activeEntry = $derived(overlayOpen ? desktopEntry : mobileEntry);

	const homeEquivalent = $derived.by(() => {
		const amount = activeEntry.amount;
		if (!view?.trip || amount.trim() === '') return null;
		const typed = parseMoney(amount, view.trip.currency.minorUnits);
		if (typed === null || typed <= 0) return null;
		const scale = 10 ** (view.currency.minorUnits - view.trip.currency.minorUnits);
		return Math.round(typed * view.trip.fxRateToHome * scale);
	});

	/**
	 * Hero figures drop trailing zero decimals. The band is rounded to the
	 * nearest step already, so "450.00" spends two glyphs implying a precision
	 * the number does not have — and precision is exactly what this screen
	 * is withholding.
	 */
	function figure(minor: number): string {
		const { minorUnits } = view!.currency;
		const s = formatMoney(minor, { minorUnits, group: true });
		return minorUnits > 0 ? s.replace(/\.0+$/, '') : s;
	}

	function dayLabel(iso: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			timeZone: 'UTC'
		}).format(new Date(iso + 'T00:00:00Z'));
	}

	function timeLabel(isoTimestamp: string): string {
		return new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).format(new Date(isoTimestamp));
	}

	const loggedCount = $derived(view ? view.strip.filter((d) => d.logged).length : 0);

	function relativeDays(dueOn: string, today: string): string {
		const days = Math.round(
			(Date.parse(dueOn + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000
		);
		if (days <= 0) return 'due now';
		if (days === 1) return 'due tomorrow';
		return `due in ${days} days`;
	}
</script>

<svelte:head>
	<title>Today · Split</title>
	<meta name="theme-color" content="#131312" media="(prefers-color-scheme: dark)" />
	<meta name="theme-color" content="#fcfcfb" media="(prefers-color-scheme: light)" />
</svelte:head>

{#if !view}
	<!-- First run. An empty screen is an invitation to act, not a broken one. -->
	<main class="shell">
		<div class="setup">
			<p class="legend">Not set up</p>
			<p class="setup-lede">
				Split needs a currency, a timezone and one open period before it can show you a number.
			</p>
			<ol class="setup-steps">
				{#if data.inContainer}
					<li><code>docker compose exec split node scripts/init.js</code></li>
					<li>
						<code>docker compose exec split node scripts/open-period.js --alloc 4200 --days 7</code>
					</li>
				{:else}
					<li><code>npm run db:migrate</code></li>
					<li><code>npm run db:init</code></li>
					<li><code>npm run period:open -- --alloc 4200 --days 7</code></li>
				{/if}
			</ol>
			<p class="setup-foot">Your daily band appears here once a period is open.</p>
		</div>
	</main>
{:else}
	<main class="shell" class:behind={overlayOpen}>
		<!-- ── The number ────────────────────────────────────────────────── -->
		<header class="head">
			<div class="legend head-line">
				<span>Today &middot; {dayLabel(view.date)}</span>
				{#if view.streak.current > 0}
					<span class="streak">Streak {view.streak.current}<span class="sr-only"> days</span></span>
				{/if}
			</div>

			<!--
				The physical record (F7), one cell per day, oldest first. It sits
				above the hero deliberately: directly beneath the band it would
				read as a progress bar for the band, which is a remaining-figure
				by another name.
			-->
			<div
				class="strip"
				role="img"
				aria-label="Logged {loggedCount} of the last {view.strip.length} days."
			>
				{#each view.strip as day (day.date)}
					<span class="cell" class:filled={day.logged} class:today={day.date === view.date}></span>
				{/each}
			</div>

			{#if view.trip}
				<!--
					The trip hero is a PRECISE figure, not a band, and it divides by
					days remaining — both deliberate inversions of the home screen.
					See tripDailyFigure() in $lib/allowance.ts for why the boundary
					condition flips the meaning.
				-->
				<div class="hero">
					<p class="sr-only">
						Spend about {local(view.trip.figureLocal)} today, day {view.trip.dayOfTrip} of {view
							.trip.tripDays}.
					</p>
					<div class="band trip-hero" aria-hidden="true">
						<span class="fig">
							<span class="sym">{view.trip.currency.symbol}</span>{new Intl.NumberFormat(
								'en-US'
							).format(view.trip.figureLocal / 10 ** view.trip.currency.minorUnits)}
						</span>
					</div>
					<div
						class="burn"
						role="img"
						aria-label="{Math.round(view.trip.burnPct)}% of the envelope drawn"
					>
						<span class="burn-fill" style="--w: {view.trip.burnPct}%"></span>
					</div>
					<p class="trip-line">
						Day {view.trip.dayOfTrip} of {view.trip.tripDays} &middot;
						{local(Math.max(0, view.trip.envelopeLocal - view.trip.drawnLocal))} left
						{#if view.trip.overLocal > 0}
							&middot; <span class="over">{local(view.trip.overLocal)} over</span>
						{/if}
					</p>
				</div>
			{:else if view.band}
				<div class="hero">
					<p class="sr-only">
						Spend around {money(view.band.low)} to {money(view.band.high)} today.
					</p>
					<div class="band" aria-hidden="true">
						<span class="fig"
							><span class="sym">{view.currency.symbol}</span>{figure(view.band.low)}</span
						>
						<span class="dim"></span>
						<span class="fig">{figure(view.band.high)}</span>
					</div>
				</div>
			{:else}
				<div class="hero">
					<p class="no-period">No open period.</p>
					<p class="no-period-hint">
						Set this period's Spend allocation and the band appears here:
						<code
							>{data.inContainer
								? 'docker compose exec split node scripts/open-period.js --alloc <amount> --days 7'
								: 'npm run period:open -- --alloc <amount> --days 7'}</code
						>
					</p>
				</div>
			{/if}
		</header>

		<!--
			The only prompts allowed on this screen, and each earns it: a review
			that is due is the 15-minute ritual carrying F7's d = 0.40, and an
			unclosed day — today's or a missed one — is a live streak about to
			break for no reason (Spec §4.6). Each one disappears the moment it is
			satisfied, so the idle screen really is the hero and nothing else.
		-->
		{#if view.reviewDue || view.streak.catchUpDate || view.pendingMoves || !view.dayClosed || view.entries.length === 0}
			<section class="prompts">
				{#if view.reviewDue}
					<a class="prompt" href="/review">
						Weekly review is due — {view.reviewDue}
						<span aria-hidden="true">→</span>
					</a>
				{/if}
				{#if view.streak.catchUpDate}
					<!--
						Two buttons because they record two different facts, and the
						only person who knows which one is true is the one who lived
						the day. Offering just the lossy catch-up quietly forces a
						zero-spend night to be filed as "details surrendered".
					-->
					<form method="POST" action="?/catchUp" use:enhance class="catch-up">
						<p class="catch-up-lede">Missed {dayLabel(view.streak.catchUpDate)}</p>
						<button class="prompt" type="submit" name="mode" value="catchup">
							File one combined entry
							<span aria-hidden="true">→</span>
						</button>
						<button class="prompt quiet" type="submit" name="mode" value="nothing">
							Nothing was spent that day
							<span aria-hidden="true">→</span>
						</button>
					</form>
				{/if}
				<!--
					Closing the day is an action, not an entries-list item — and it
					used to live inside .entries, which the desktop shell hides. That
					made the zero-day log, the one thing that keeps a streak alive on
					a day you spend nothing, unreachable on a wide screen entirely.
				-->
				{#if !view.dayClosed}
					<form method="POST" action="?/logNothing" use:enhance bind:this={nothingForm}>
						<button class="prompt quiet" type="submit">
							Nothing to log tonight
							<kbd class="only-wide">N</kbd>
						</button>
					</form>
				{:else if view.entries.length === 0}
					<p class="prompt done">
						<span aria-hidden="true">✓</span> Logged. Nothing spent today.
					</p>
				{/if}
				{#if view.pendingMoves}
					<a class="prompt" href="/accounts">
						{view.pendingMoves.count === 1
							? `1 transfer not yet made — ${view.pendingMoves.firstLabel}`
							: `${view.pendingMoves.count} transfers not yet made`}
						<span aria-hidden="true">→</span>
					</a>
				{/if}
			</section>
		{/if}

		<!--
			The 72 hours are up (Spec §8.1.5). Only renders when something is
			ripe. Most items die on this list, and the ones that survive you buy
			without the cognitive cost of having resisted.
		-->
		{#each view.ripeWaits as w (w.id)}
			<div class="ripe">
				<p class="ripe-label">
					Your 72 hours are up on <strong>{w.label}</strong>
					{#if w.amountMinor}<span class="muted"> · {money(w.amountMinor)}</span>{/if}
				</p>
				<div class="ripe-actions">
					<form method="POST" action="?/resolveWait" use:enhance>
						<input type="hidden" name="id" value={w.id} />
						<button type="submit" name="outcome" value="bought">Buy it</button>
					</form>
					<form method="POST" action="?/resolveWait" use:enhance>
						<input type="hidden" name="id" value={w.id} />
						<button type="submit" name="outcome" value="dropped">Drop it</button>
					</form>
				</div>
			</div>
		{/each}

		<!--
			Horizon (Spec §8.1.6). One line, only within seven days, and the
			status carries an icon and a word — never colour alone.
		-->
		{#if view.horizon}
			<p class="horizon">
				<span>{view.horizon.label} — {relativeDays(view.horizon.dueOn, view.date)}</span>
				<span class="horizon-status" class:funded={view.horizon.funded}>
					<span aria-hidden="true">{view.horizon.funded ? '✓' : '!'}</span>
					{view.horizon.funded ? 'funded' : 'not yet funded'}
				</span>
			</p>
		{/if}

		<!--
			A subscription decision inside 7 days. A name, a date and a verb — no
			amount, because the question is "do I still want this", and quoting
			the price invites haggling with yourself instead of answering it.
		-->
		{#if view.subscriptionDue}
			<p class="horizon">
				<a class="sub-due" href="/subscriptions">
					{view.subscriptionDue.isTrial ? 'Free trial ends' : 'Renews'} —
					{view.subscriptionDue.label}
				</a>
				<span class="horizon-status">
					<span aria-hidden="true">!</span>
					{relativeDays(view.subscriptionDue.deadline, view.date)}
				</span>
			</p>
		{/if}

		<!-- ── Today's entries. No running total — that is a balance in disguise. -->
		<section class="entries" aria-label="Today's entries">
			{#if view.entries.length > 0}
				<ul>
					{#each view.entries as entry, i (entry.id)}
						<li class="entry" class:just-saved={form?.saved && i === 0}>
							<span class="entry-cat">
								{CATEGORIES.find((c) => c.key === entry.category)?.label}
								{#if !entry.planned}
									<span class="flag">unplanned</span>
								{:else}
									<span class="sr-only">planned</span>
								{/if}
							</span>
							<span class="entry-time">{timeLabel(entry.enteredAt)}</span>
							{#if view.trip && entry.amountLocalMinor !== null}
								<span class="entry-amt">
									{local(entry.amountLocalMinor)}
									<span class="entry-home">{money(entry.amountMinor)}</span>
								</span>
							{:else}
								<span class="entry-amt">{money(entry.amountMinor)}</span>
							{/if}
							<form method="POST" action="?/deleteTxn" use:enhance>
								<input type="hidden" name="id" value={entry.id} />
								<button class="entry-del" type="submit" aria-label="Delete this entry">
									&times;
								</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- ── The log strip. Bottom third, thumb-first, always visible. ──── -->
		<form class="log" method="POST" action="?/logTxn" use:enhance={logSubmit(mobileEntry)}>
			<input type="hidden" name="clientUuid" value={mobileEntry.clientUuid} />

			<label class="amount">
				<span class="sr-only">Amount spent</span>
				<span class="amount-sym" aria-hidden="true"
					>{view.trip ? view.trip.currency.symbol : view.currency.symbol}</span
				>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					name="amount"
					bind:value={mobileEntry.amount}
					type="text"
					inputmode={view.trip && view.trip.currency.minorUnits === 0 ? 'numeric' : 'decimal'}
					autocomplete="off"
					autocorrect="off"
					spellcheck="false"
					placeholder="0"
					autofocus
				/>
			</label>

			{#if view.trip}
				<!--
					Not a convenience. Foreign currency weakens the pain of paying,
					and this conversion is the friction the unfamiliar notes
					removed (F11).
				-->
				<p class="equiv" aria-live="polite">
					{#if homeEquivalent !== null}
						≈ {money(homeEquivalent)} at the rate you locked
					{:else}
						Home equivalent appears as you type
					{/if}
				</p>
			{/if}

			<fieldset class="chips">
				<legend class="sr-only">Category</legend>
				{#each CATEGORIES as cat (cat.key)}
					<label class="chip" class:on={mobileEntry.category === cat.key}>
						<input type="radio" name="category" value={cat.key} bind:group={mobileEntry.category} />
						{cat.label}
					</label>
				{/each}
			</fieldset>

			<fieldset class="seg">
				<legend class="sr-only">Was this planned?</legend>
				<label class="seg-opt" class:on={mobileEntry.planned === '1'}>
					<input type="radio" name="planned" value="1" bind:group={mobileEntry.planned} />
					Planned
				</label>
				<label class="seg-opt" class:on={mobileEntry.planned === '0'}>
					<input type="radio" name="planned" value="0" bind:group={mobileEntry.planned} />
					Unplanned
				</label>
			</fieldset>

			<button class="save" type="submit" disabled={!mobileEntry.ready}>Save entry</button>

			{#if form?.error}
				<p class="err" role="alert">{form.error}</p>
			{/if}
		</form>

		<!-- Desktop only: the idle screen is the hero, so the way in is a hint. -->
		<p class="kbd-hint">
			<kbd>⌘K</kbd> to log · start typing a number
			{#if !view.dayClosed}
				· <kbd>N</kbd> for a zero day
			{/if}
		</p>
	</main>

	<LogOverlay
		entry={desktopEntry}
		bind:open={overlayOpen}
		currency={view.currency}
		tripCurrency={view.trip ? view.trip.currency : null}
		{homeEquivalent}
		entries={view.entries}
		onClose={() => (overlayOpen = false)}
		{onSaved}
	/>

	{#if toast}
		<p class="toast" data-motion="fade" role="status">{toast}</p>
	{/if}
{/if}

<style>
	.shell {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
		max-width: 30rem;
		margin-inline: auto;
		padding: max(1.25rem, env(safe-area-inset-top)) 1.25rem max(1rem, env(safe-area-inset-bottom));
		gap: 1.5rem;
	}

	/* ── Head ─────────────────────────────────────────────────────────── */
	.head {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding-top: 1.5rem;
	}

	.hero {
		min-height: 4.5rem;
		margin-top: 1.25rem;
	}

	/*
	 * The signature: the band drawn as a dimension line, the way a range is
	 * annotated on a technical drawing. It reads as a measured span before you
	 * read either number — which is the entire behavioural point of F5. A
	 * single large figure would read as a balance, and get spent to.
	 */
	.band {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--ink);
	}

	.fig {
		/* The floor is 3rem, not 2.75rem: §8.0b.2 sets a hard ≥48px minimum and
		   12vw falls to 46.8px on a 390px phone, which is most phones. */
		font-size: clamp(3rem, 12vw, 3.5rem);
		font-weight: 400;
		line-height: 1;
		letter-spacing: 0; /* numerals are never letterspaced */
		font-variant-numeric: proportional-nums;
		white-space: nowrap;
	}

	.sym {
		font-size: 0.42em;
		color: var(--ink-muted);
		margin-right: 0.14em;
		vertical-align: 0.32em;
	}

	.dim {
		flex: 1 1 auto;
		min-width: 1.5rem;
		height: 0.7rem;
		position: relative;
		border-left: 1px solid var(--ink-muted);
		border-right: 1px solid var(--ink-muted);
	}

	.dim::before {
		content: '';
		position: absolute;
		inset-inline: 0;
		top: 50%;
		height: 1px;
		background: var(--ink-muted);
	}

	.no-period {
		font-size: 1.5rem;
		margin: 0 0 0.5rem;
		color: var(--ink-secondary);
	}

	.no-period-hint {
		margin: 0;
		color: var(--ink-muted);
		font-size: 0.875rem;
		max-width: 24rem;
	}

	.no-period-hint code {
		font-family: var(--font-mono);
		font-size: 0.8125em;
	}

	.head-line {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}

	.streak {
		color: var(--ink-secondary);
	}

	/* ── Prompts ──────────────────────────────────────────────────────── */
	.prompts {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: -0.5rem;
	}

	.prompt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		min-height: var(--touch);
		padding: 0 0.875rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		color: var(--ink-secondary);
		font-family: inherit;
		font-size: 0.9375rem;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.prompt:hover {
		color: var(--ink);
		border-color: var(--ink-muted);
	}

	/* ── Trip hero ────────────────────────────────────────────────────── */
	.trip-hero {
		justify-content: flex-start;
	}

	.burn {
		position: relative;
		height: 3px;
		margin-top: 1rem;
		background: var(--hairline);
		border-radius: 1px;
	}

	.burn-fill {
		position: absolute;
		inset-block: 0;
		left: 0;
		width: var(--w);
		background: var(--ink-secondary);
		border-radius: 1px;
	}

	.trip-line {
		margin: 0.625rem 0 0;
		font-size: 0.875rem;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	.over {
		color: var(--status-warning);
	}

	.equiv {
		margin: -0.25rem 0 0;
		font-size: 0.8125rem;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	.entry-home {
		display: block;
		font-size: 0.75rem;
		color: var(--ink-muted);
	}

	/* ── Ripe 72-hour items ───────────────────────────────────────────── */
	.ripe {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: -0.5rem;
		padding: 0.875rem;
		border: 1px solid var(--hairline-strong);
		border-left: 3px solid var(--accent);
		border-radius: 0.5rem;
	}

	.ripe-label {
		margin: 0;
		font-size: 0.9375rem;
		color: var(--ink-secondary);
	}

	.muted {
		color: var(--ink-muted);
	}

	.ripe-actions {
		display: flex;
		gap: 0.5rem;
	}

	.ripe-actions button {
		min-height: var(--touch);
		padding: 0 0.875rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		color: var(--ink-secondary);
		font-family: inherit;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.ripe-actions button:hover {
		color: var(--ink);
		border-color: var(--ink-muted);
	}

	.catch-up {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.catch-up-lede {
		margin: 0;
		color: var(--ink-muted);
		font-size: 0.8125rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.prompt.quiet {
		color: var(--ink-muted);
		border-style: dashed;
	}

	.prompt.done {
		margin: 0;
		border-style: dashed;
		color: var(--ink-secondary);
		cursor: default;
	}

	.prompt.done span {
		color: var(--status-good);
	}

	.prompt kbd {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
	}

	/* The N hint is keyboard-only, so it stays off the phone. */
	.only-wide {
		display: none;
	}

	@media (min-width: 48rem) {
		.only-wide {
			display: inline-block;
		}
	}

	/* ── Horizon ──────────────────────────────────────────────────────── */
	.horizon {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin: -0.75rem 0 0;
		font-size: 0.9375rem;
		color: var(--ink-secondary);
	}

	.sub-due {
		color: var(--ink-secondary);
		text-decoration: underline;
		text-underline-offset: 4px;
		text-decoration-color: var(--hairline-strong);
	}

	.horizon-status {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--status-warning);
	}

	.horizon-status.funded {
		color: var(--status-good);
	}

	/* ── The 28-day record ────────────────────────────────────────────── */
	.strip {
		display: flex;
		gap: 3px;
	}

	.cell {
		width: 8px;
		height: 8px;
		border-radius: 1px;
		background: var(--hairline);
	}

	.cell.filled {
		background: var(--ink-secondary);
	}

	.cell.today {
		box-shadow: 0 0 0 1px var(--ink-muted);
	}

	/* ── Entries ──────────────────────────────────────────────────────── */
	.entries {
		flex: 1 1 auto;
		min-height: 2.75rem;
		overflow-y: auto;
	}

	/* One grid for the whole list, so the amount column actually aligns —
	   which is the only reason tabular-nums is used here (Spec §8.0b.8). */
	.entries ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto var(--touch);
		/* The gap lives on the parent: a subgrid row inherits it, and setting
		   it again on the row would double-count and overflow the track. */
		column-gap: 0.75rem;
	}

	.entry {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		min-height: var(--touch);
		border-bottom: 1px solid var(--hairline);
	}

	.entry:last-child {
		border-bottom: 0;
	}

	.entry-cat {
		color: var(--ink-secondary);
		font-size: 0.9375rem;
	}

	.flag {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-muted);
		margin-left: 0.5rem;
	}

	.entry-time {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	.entry-amt {
		font-family: var(--font-mono);
		font-size: 0.9375rem;
		font-variant-numeric: tabular-nums; /* a column that must align */
		color: var(--ink);
		text-align: right;
	}

	.entry-del {
		width: var(--touch);
		height: var(--touch);
		background: none;
		border: 0;
		color: var(--ink-muted);
		font-size: 1.25rem;
		cursor: pointer;
	}

	.entry-del:hover {
		color: var(--ink);
	}

	.just-saved {
		animation: settle 180ms ease-out;
	}

	@keyframes settle {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	/* ── The log strip ────────────────────────────────────────────────── */
	.log {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--hairline);
	}

	.amount {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.amount-sym {
		font-size: 1.25rem;
		color: var(--ink-muted);
	}

	.amount input {
		flex: 1 1 auto;
		width: 100%;
		min-height: var(--touch);
		background: none;
		border: 0;
		border-bottom: 1px solid var(--hairline-strong);
		color: var(--ink);
		font-family: inherit;
		font-size: 2rem;
		font-variant-numeric: proportional-nums;
		padding: 0 0 0.25rem;
	}

	.amount input::placeholder {
		color: var(--hairline-strong);
	}

	.amount input:focus {
		outline: none;
		border-bottom-color: var(--accent);
	}

	.chips,
	.seg {
		border: 0;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	/* Two columns by default: hittable without looking, one-handed, in the
	   dark (Spec §8.0b.4). Four only where the row genuinely fits. */
	.chips {
		grid-template-columns: repeat(2, 1fr);
	}

	/* A joined segment, not two more pills. The category chips and the
	   planned/unplanned flag are different questions and must not look like
	   the same one. */
	.seg {
		grid-template-columns: repeat(2, 1fr);
		gap: 0;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		overflow: hidden;
	}

	@media (min-width: 30rem) {
		.chips {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	.chip,
	.seg-opt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: var(--touch);
		padding: 0 0.875rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		color: var(--ink-secondary);
		font-size: 0.875rem;
		white-space: nowrap;
		cursor: pointer;
		transition: none;
	}

	.seg-opt {
		border: 0;
		border-radius: 0;
	}

	.seg-opt + .seg-opt {
		border-left: 1px solid var(--hairline-strong);
	}

	.chip.on,
	.seg-opt.on {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--ground);
	}

	.chip input,
	.seg-opt input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.chip:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* The segment clips its children, so its focus ring has to be inset. */
	.seg-opt:has(input:focus-visible) {
		box-shadow: inset 0 0 0 2px var(--accent);
	}

	.save {
		min-height: 3.25rem;
		margin-top: 0.25rem;
		background: var(--ink);
		color: var(--ground);
		border: 0;
		border-radius: 0.5rem;
		font-family: inherit;
		font-size: 1rem;
		font-weight: 500;
		cursor: pointer;
	}

	.save:disabled {
		background: none;
		border: 1px solid var(--hairline);
		color: var(--ink-muted);
		cursor: not-allowed;
	}

	.err {
		margin: 0;
		color: var(--ink);
		font-size: 0.875rem;
	}

	/* ── First run ────────────────────────────────────────────────────── */
	.setup {
		margin-block: auto;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.setup-lede {
		margin: 0;
		font-size: 1.25rem;
		color: var(--ink);
		max-width: 26rem;
	}

	.setup-steps {
		margin: 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		color: var(--ink-secondary);
	}

	.setup-steps code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.setup-foot {
		margin: 0;
		color: var(--ink-muted);
		font-size: 0.875rem;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}

	/* The keyboard hint and the toast belong to the desktop shell only. */
	.kbd-hint {
		display: none;
	}

	.toast {
		position: fixed;
		left: 50%;
		bottom: 2.5rem;
		z-index: 50;
		translate: -50% 0;
		margin: 0;
		padding: 0.75rem 1.125rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		color: var(--ink-secondary);
		font-size: 0.875rem;
		white-space: nowrap;
		box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.5);
		animation: toast-in 180ms ease-out;
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			translate: -50% 6px;
		}
	}

	/* ─────────────────────────────────────────────────────────────────────
	   DESKTOP (≥768px)

	   A resident form on a wide screen makes Today read as a data-entry app,
	   and it competes with the hero — which §8.0b.2 says means the screen is
	   wrong. So the idle state is the number and nothing else, and the form is
	   summoned. Mobile is untouched: §8.0b.4's thumb-first rule is about
	   logging in bed and has no claim here.
	   ───────────────────────────────────────────────────────────────────── */
	@media (min-width: 48rem) {
		.shell {
			max-width: 44rem;
			min-height: 100dvh;
			justify-content: center;
			gap: 2rem;
			padding-block: 3rem;
			transition:
				filter 160ms ease-out,
				opacity 160ms ease-out;
		}

		/* The hero blurs and dims behind the overlay rather than unmounting —
		   the number you came to check stays the thing on screen. */
		.shell.behind {
			filter: blur(3px);
			opacity: 0.45;
			pointer-events: none;
		}

		.head {
			gap: 1.25rem;
			padding-top: 0;
		}

		.fig {
			/* 72px → 150px fluid. */
			font-size: clamp(4.5rem, 9vw, 9.375rem);
		}

		.hero {
			min-height: 0;
			margin-top: 0.5rem;
		}

		.dim {
			height: 1rem;
		}

		.cell {
			width: 10px;
			height: 10px;
		}

		/* Everything that made it feel like a form. */
		.entries,
		.log {
			display: none;
		}

		.prompts {
			margin-top: 0;
			max-width: 34rem;
		}

		.horizon {
			margin-top: 0;
		}

		.kbd-hint {
			display: block;
			margin: 0;
			color: var(--ink-muted);
			font-size: 0.8125rem;
		}

		.kbd-hint kbd {
			font-family: var(--font-mono);
			font-size: 0.75rem;
			padding: 0.1rem 0.35rem;
			border: 1px solid var(--hairline-strong);
			border-radius: 0.25rem;
		}
	}
</style>
