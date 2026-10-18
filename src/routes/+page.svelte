<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import LogOverlay from '$lib/components/LogOverlay.svelte';
	import EntryResolution from '$lib/components/EntryResolution.svelte';
	import ActionView from '$lib/components/actions/ActionView.svelte';
	import NavStrip from '$lib/components/NavStrip.svelte';
	import { CATEGORIES, categoryLabel, type CategoryKey } from '$lib/categories';
	import {
		LogEntry,
		TripEntry,
		offlineLogSubmit,
		resolveLive,
		tripSubmit,
		type TripSnapshot
	} from '$lib/log-entry.svelte';
	import * as outbox from '$lib/outbox';
	import type { ParsedEntry, ParseContext } from '$lib/entry-parser';
	import { formatMoney, parseMoney } from '$lib/money';
	import { ACTION_PILLS } from '$lib/actions/catalogue';
	import { actionViewFor } from '$lib/actions/action-view';
	import { draftForAction, type ActionDraft } from '$lib/actions/draft';
	import { resolveProtectedIntent } from '$lib/actions/intent';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const view = $derived(data.view);
	// Public demo: no links to screens the demo hides.
	const demo = $derived(data.demo === true);

	// The router's context arrives once per load, refreshed automatically
	// after every save (Spec §5.6-§5.7, task A4a's design). Only absent when
	// there is no view to attach a log form to at all.
	const emptyParseContext: ParseContext = { dict: {}, learned: {}, commitments: [] };
	const parseContext = $derived(data.parseContext ?? emptyParseContext);

	const DESKTOP = '(min-width: 48rem)';

	/*
	 * Two shells, one entry. Mobile keeps the resident form (§8.0b.4 — the log
	 * happens in bed, one-handed); desktop summons an overlay so nothing
	 * competes with the hero (§8.0b.2).
	 *
	 * Two entry SHAPES, not two entry FORKS: `LogEntry` is the typed field
	 * this task builds, and `TripEntry` is the pre-A4 amount/category/planned
	 * form kept only for a trip in progress — see `log-entry.svelte.ts`'s
	 * module doc for why A4a's router does not reach trips at all.
	 *
	 * Neither defaults the planned/unplanned flag. A default makes the unplanned
	 * ratio mean something different depending on which device you were holding,
	 * and that ratio is the direct measure of exceptional-expense blindness
	 * losing its grip on you (F10) — a metric with two definitions measures
	 * nothing. It costs nothing on desktop either, because P and U *are* the
	 * save action; all that goes away is bare Enter recording a judgement you
	 * never made.
	 */
	const mobileEntry = new LogEntry();
	const desktopEntry = new LogEntry();
	const mobileTripEntry = new TripEntry('');
	const desktopTripEntry = new TripEntry('');

	let mobileFormEl = $state<HTMLFormElement | undefined>();
	let nothingForm = $state<HTMLFormElement | undefined>();
	let overlayOpen = $state(false);
	/** The action the typing bar has switched to (a pill was tapped) — the
	 * desktop overlay's *content*, not a second surface. `undefined` is the
	 * bar itself. Owner request: one surface, so a pill swaps the panel's
	 * content instead of closing it and opening the Actions panel. */
	let actionId = $state<string | undefined>(undefined);
	/** The same idea for the mobile bar, which is the resident field rather
	 * than an overlay: the field is replaced by the action view in place. */
	let mobileActionId = $state<string | undefined>(undefined);
	let desktopActionDraft = $state<ActionDraft | undefined>(undefined);
	let mobileActionDraft = $state<ActionDraft | undefined>(undefined);
	let desktopIntentChoices = $state<{ source: string; ids: string[] } | null>(null);
	let mobileIntentChoices = $state<{ source: string; ids: string[] } | null>(null);
	let desktopIntentLoading = $state(false);
	let mobileIntentLoading = $state(false);
	let intentSequence = 0;
	let isDesktop = $state(false);
	let toast = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * The offline outbox's queue count (Spec §6, task A5). A COUNT, never a
	 * sum of money — Invariant 1 governs this line exactly as it governs the
	 * hero band, and the markup below hides it entirely once it hits zero
	 * rather than rendering an empty state.
	 */
	let queuedCount = $state(0);
	let queueStuck = $state<string | null>(null);

	/*
	 * Two absences on this page, both deliberate, both easy to "fix" back in.
	 *
	 * The destination list is gone. It used to live here as a `DOOR` array with
	 * a description per entry, behind a toggle. It is now `NavStrip`, reading
	 * the single `$lib/nav/destinations` list that every screen shares, so the
	 * nine destinations cannot drift between Today and the other screens again.
	 * The descriptions are not coming back: they answer "what is this tab" once
	 * and are noise every night after (DESIGN.md, Voice).
	 *
	 * The A6 money-in forms ("Money landed" / "Money back") live in their own
	 * components, `$lib/components/actions/RecordIncomeForm.svelte` and
	 * `RecordRefundForm.svelte`, rendered by the typing bar's action view
	 * (`ActionView.svelte`). Today's own markup does not duplicate them
	 * (Spec A2: "Do not... show the whole action catalogue permanently";
	 * Spec A6: no duplicated accounting code across routes).
	 */

	async function refreshQueuedCount() {
		if (data.userId == null) return;
		queuedCount = await outbox.count(data.userId);
		// A queue that only counts hides a permanent refusal. Surface the reason
		// from the oldest failed row so the number is never mysterious.
		const rows = await outbox.list(data.userId);
		const failed = rows.find((r) => r.lastError);
		queueStuck = failed ? failed.lastError! : null;
	}

	/** Runs on `online` and on app open (task A5 item 4's two GUARANTEED
	 * triggers — Background Sync in service-worker.ts is a best-effort bonus
	 * on top of these, never a replacement: iOS Safari has no Background
	 * Sync at all, so app-open is the only thing that ever drains its
	 * queue). A successful send changes what Today shows (a new entry, a
	 * moved band), so `invalidateAll()` refreshes `view` the same way a live
	 * save already does via `use:enhance`'s own `update()`. */
	async function flushOutbox() {
		if (data.userId == null) return;
		const result = await outbox.flush(data.userId);
		await refreshQueuedCount();
		if (result.sent > 0) await invalidateAll();
	}

	function describeTrip(s: TripSnapshot): string {
		const minorUnits = view!.trip ? view!.trip.currency.minorUnits : view!.currency.minorUnits;
		const symbol = view!.trip ? view!.trip.currency.symbol : view!.currency.symbol;
		const parsed = parseMoney(s.amount, minorUnits);
		const amountText =
			parsed === null ? s.amount : formatMoney(parsed, { minorUnits, symbol }).replace(/\.00$/, '');
		return `Logged ${amountText} · ${categoryLabel(s.category as CategoryKey)} · ${
			s.planned === '1' ? 'planned' : 'unplanned'
		}`;
	}

	function onTripSaved(s: TripSnapshot) {
		overlayOpen = false;
		toast = describeTrip(s);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 2400);
	}

	/** The typed entry's toast text, by resolved kind (Spec §5.6's table). */
	function describeEntry(s: ParsedEntry): string {
		switch (s.kind) {
			case 'transaction':
				return `Logged ${money(s.amountMinor ?? 0)} · ${s.english} · ${categoryLabel(s.root)}`;
			case 'existing_commitment':
				return s.commitment.kind === 'subscription'
					? 'Already covered — nothing logged.'
					: `Logged ${money(s.amountMinor ?? 0)} against ${s.commitment.label}.`;
			case 'new_commitment':
				return `Added ${s.english} as a new commitment.`;
			case 'transfer':
				return 'Noted — nothing logged.';
			default:
				return 'Saved.';
		}
	}

	function onDesktopEntrySaved(s: ParsedEntry) {
		overlayOpen = false;
		toast = describeEntry(s);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 2400);
	}

	async function submitMobileEntry() {
		await tick();
		mobileFormEl?.requestSubmit();
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

			// ⌘K / Ctrl+K opens the logging bar itself — the actions live on its
			// pills, and the Actions panel it used to open is gone (owner
			// request: one surface, so the transition is seamless).
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				openLogOverlay();
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
				if (view?.trip) {
					desktopTripEntry.reset();
					desktopTripEntry.amount = event.key;
				} else {
					desktopEntry.reset();
					desktopEntry.text = event.key;
				}
				overlayOpen = true;
			}
		}

		window.addEventListener('keydown', onKeydown);

		// The offline outbox (Spec §6, task A5). Three of its triggers live
		// here: "app open" (this call, right away), "online" (the listener
		// below), and telling a controlling service worker which user is
		// live so its best-effort Background Sync handler never sends a row
		// under the wrong session (service-worker.ts's own doc comment).
		// Background Sync registration is the fourth trigger and is
		// deliberately fire-and-forget — see `registerBackgroundSync()`.
		refreshQueuedCount();
		void flushOutbox();
		function tellServiceWorker() {
			if (data.userId != null) outbox.tellServiceWorkerCurrentUser(data.userId);
		}
		tellServiceWorker();
		// The controlling worker can change after this mount (a fresh install
		// only takes over once `clients.claim()` runs in `activate` — see
		// service-worker.ts) — resend once that happens rather than assuming
		// the very first attempt landed.
		navigator.serviceWorker?.addEventListener('controllerchange', tellServiceWorker);
		void outbox.registerBackgroundSync();
		window.addEventListener('online', flushOutbox);

		return () => {
			mq.removeEventListener('change', onChange);
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('online', flushOutbox);
			navigator.serviceWorker?.removeEventListener('controllerchange', tellServiceWorker);
			clearTimeout(toastTimer);
		};
	});

	function money(minor: number): string {
		return formatMoney(minor, {
			minorUnits: view!.currency.minorUnits,
			symbol: view!.currency.symbol
		});
	}

	/** Open the log overlay the same way typing a digit does — empty field,
	 * focused, and back on the bar rather than on whatever action was open. */
	function openLogOverlay() {
		intentSequence++;
		actionId = undefined;
		desktopActionDraft = undefined;
		desktopIntentChoices = null;
		if (!window.matchMedia(DESKTOP).matches || !view) return;
		if (view.trip) desktopTripEntry.reset();
		else desktopEntry.reset();
		overlayOpen = true;
	}

	/**
	 * An action-feature pill on the typing bar (Record income, Transfer
	 * money, Record a payment...). The bar no longer hands off to a second
	 * surface (owner request: seamless transition) — the same panel, or the
	 * same resident field, swaps its content to that action's view.
	 *
	 * The one exception is a `dedicated` action: its form lives on its own
	 * tab and this page has no server action to submit it, so the bar
	 * navigates there rather than rendering a form that could not be saved.
	 */
	function openActionFromPill(id: string) {
		intentSequence++;
		desktopActionDraft = undefined;
		mobileActionDraft = undefined;
		desktopIntentChoices = null;
		mobileIntentChoices = null;
		const view = actionViewFor(id);
		if (view?.kind === 'navigate') {
			actionId = undefined;
			mobileActionId = undefined;
			overlayOpen = false;
			void goto(view.target);
			return;
		}
		if (isDesktop) {
			actionId = id;
			overlayOpen = true;
		} else {
			mobileActionId = id;
		}
	}

	/** Keep the original sentence while the person reviews the proposed form. */
	function openIntentAction(id: string, desktop: boolean, raw: string) {
		if (!view) return;
		const target = actionViewFor(id);
		if (!target) return;
		if (target.kind === 'navigate') {
			openActionFromPill(id);
			return;
		}
		const previous = desktop ? desktopActionDraft : mobileActionDraft;
		const draft = previous?.sourceText === raw && previous.actionId === id
			? previous
			: draftForAction(id, raw, view.currency.minorUnits);
		if (desktop) {
			desktopActionDraft = draft;
			desktopIntentChoices = null;
			actionId = draft.actionId;
			overlayOpen = true;
		} else {
			mobileActionDraft = draft;
			mobileIntentChoices = null;
			mobileActionId = draft.actionId;
		}
	}

	function fallbackIntentChoices(raw: string): string[] {
		if (!view) return [];
		const local = resolveProtectedIntent(raw, parseContext, view.currency.minorUnits);
		if (local.kind === 'spending' || local.kind === 'existing') return [];
		const first = local.kind === 'action' ? [local.actionId] : [];
		return [...new Set([...first, 'add-bill-subscription', 'transfer-money', 'add-debt'])].slice(0, 3);
	}

	async function continueTypedRequest(desktop: boolean) {
		if (!view) return;
		const entry = desktop ? desktopEntry : mobileEntry;
		const raw = entry.text.trim();
		if (!raw) return;
		const sequence = ++intentSequence;
		if (desktop) desktopIntentLoading = true;
		else mobileIntentLoading = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3500);
		try {
			const response = await fetch('/api/intent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: raw }),
				signal: controller.signal
			});
			const result: unknown = response.ok ? await response.json() : null;
			if (sequence !== intentSequence || entry.text.trim() !== raw) return;
			if (result && typeof result === 'object') {
				const answer = result as { kind?: unknown; actionId?: unknown; actionIds?: unknown };
				if (answer.kind === 'action' && typeof answer.actionId === 'string' && actionViewFor(answer.actionId)) {
					openIntentAction(answer.actionId, desktop, raw);
					return;
				}
				if (answer.kind === 'choices' && Array.isArray(answer.actionIds)) {
					const ids = answer.actionIds.filter((id): id is string => typeof id === 'string' && Boolean(actionViewFor(id))).slice(0, 3);
					const choices = { source: raw, ids };
					if (desktop) desktopIntentChoices = choices;
					else mobileIntentChoices = choices;
					return;
				}
			}
		} catch {
			// The optional service or connection can fail; keep the typed text.
		} finally {
			clearTimeout(timer);
			if (sequence === intentSequence) {
				if (desktop) desktopIntentLoading = false;
				else mobileIntentLoading = false;
			}
		}
		if (sequence !== intentSequence || entry.text.trim() !== raw) return;
		const choices = { source: raw, ids: fallbackIntentChoices(raw) };
		if (desktop) desktopIntentChoices = choices;
		else mobileIntentChoices = choices;
	}

	/** Amounts in the trip's own currency, at the trip's own scale. */
	function local(minor: number): string {
		const t = view!.trip!;
		return formatMoney(minor, { minorUnits: t.currency.minorUnits, symbol: t.currency.symbol });
	}

	// The live home-currency figure under the keypad is not a convenience — it
	// is the countermeasure. Foreign currency weakens the pain of paying, and
	// the conversion is the friction the unfamiliar notes removed (F11).
	// Trip-form only — the typed entry never runs during a trip (see this
	// file's TripEntry/LogEntry split, above).
	const activeTripEntry = $derived(overlayOpen ? desktopTripEntry : mobileTripEntry);

	const homeEquivalent = $derived.by(() => {
		const amount = activeTripEntry.amount;
		if (!view?.trip || amount.trim() === '') return null;
		const typed = parseMoney(amount, view.trip.currency.minorUnits);
		if (typed === null || typed <= 0) return null;
		const scale = 10 ** (view.currency.minorUnits - view.trip.currency.minorUnits);
		return Math.round(typed * view.trip.fxRateToHome * scale);
	});

	/** The mobile field's live resolution — the desktop overlay computes its
	 * own from the same `parseContext`, since only one shell is ever open. */
	const mobileResolved = $derived<ParsedEntry>(
		view ? resolveLive(mobileEntry, parseContext, view.currency.minorUnits) : { kind: 'empty' }
	);

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
	<main class="shell">
		<div class="setup">
			<p class="legend">Not set up</p>
			<p class="setup-lede">Five questions, and Split can show you a number.</p>
			{#if !demo}<a class="setup-go" href="/setup">Set up Split</a>{/if}
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
					{#if !demo}<a class="setup-go" href="/setup">Finish setting up</a>{/if}
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
		{#if view.reviewDue || view.missed.length > 0 || (view.pendingMoves && !demo) || !view.dayClosed || view.entries.length === 0}
			<section class="prompts">
				{#if view.reviewDue}
					<a class="prompt" href="/review">
						Weekly review is due — {view.reviewDue}
						<span aria-hidden="true">→</span>
					</a>
				{/if}
				{#if view.missed.length > 0}
					<!--
						Catch-up, one row per missed day (Spec §4.6, extended).

						It used to reach exactly one day, so a missed weekend was
						permanently a hole and the streak broke for something you
						could not fix.

						One field PER DAY, never one for the week. Finding 10: people
						underestimate weekly spending by ~30%, and the named debiaser
						is "predicting events rather than time periods". A single box
						for a week understates, in the direction that reads
						comfortably and is wrong.

						This is the same typed field as tonight's log, because it is
						the same act — you are recalling purchases either way, just
						further back.
					-->
					<div class="catch-up">
						<p class="catch-up-lede">
							{view.missed.length === 1
								? `Missed ${dayLabel(view.missed[0])}`
								: `Missed ${view.missed.length} days`}
						</p>

						{#each view.missed as d (d)}
							<form method="POST" action="?/catchUpDay" use:enhance class="missed-row">
								<input type="hidden" name="date" value={d} />
								<span class="missed-day">{dayLabel(d)}</span>
								<input
									class="missed-text"
									name="text"
									type="text"
									autocomplete="off"
									placeholder="kape 65, grab 180"
									aria-label="What you spent on {dayLabel(d)}"
								/>
								<button class="missed-file" type="submit" name="mode" value="entries">
									File
								</button>
								<button class="missed-alt" type="submit" name="mode" value="nothing">
									Nothing
								</button>
								<button class="missed-alt" type="submit" name="mode" value="forgot">
									Can&rsquo;t recall
								</button>
							</form>
						{/each}
					</div>
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
				{#if view.pendingMoves && !demo}
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
		{#if view.subscriptionDue && !demo}
			<!-- A `div`, not a `p`: HTML forbids nesting a `<form>` inside `<p>`. -->
			<div class="horizon">
				<a class="sub-due" href="/subscriptions">
					{view.subscriptionDue.isTrial ? 'Free trial ends' : 'Renews'} —
					{view.subscriptionDue.label}
				</a>
				<span class="horizon-status">
					<span aria-hidden="true">!</span>
					{relativeDays(view.subscriptionDue.deadline, view.date)}
				</span>
				<!--
					Spec §7.4: the same one-click decision the review cull already has,
					reached from wherever the deadline is actually shown. No new
					widget — this is the existing subscriptionDue line, not an addition
					to Today's closed widget list (Spec §8.1).
				-->
				<form method="POST" action="?/cancelSub" use:enhance class="sub-due-cancel">
					<input type="hidden" name="id" value={view.subscriptionDue.id} />
					<button type="submit" class="mini">I cancelled it</button>
				</form>
			</div>
		{:else if form?.cancelledSubId}
			<div class="horizon">
				<span>Cancelled {form.cancelledSubLabel}.</span>
				<form method="POST" action="?/restoreSub" use:enhance class="sub-due-cancel">
					<input type="hidden" name="id" value={form.cancelledSubId} />
					<button type="submit" class="mini">Undo</button>
				</form>
			</div>
		{/if}

		<!-- ── Today's entries. No running total — that is a balance in disguise. -->
		<section class="entries" aria-label="Today's entries">
			{#if view.entries.length > 0}
				<ul>
					{#each view.entries as entry, i (entry.id)}
						<li
							class="entry"
							class:just-saved={form?.saved &&
								(form?.wrote === undefined || form.wrote === 'transaction') &&
								i === 0}
						>
							<span class="entry-cat">
								{#if entry.refundOf !== null}
									<!-- Money back, not new spending — it reads as the opposite sign
									     even though the row amount stays positive. Refunds land in
									     whichever account the user picked, not the original's. -->
									<span class="flag refund-flag">money back</span>
								{/if}
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
		{#if view.trip}
			<!-- A trip in progress still logs through the pre-A4 amount/category/
			     planned form: `commitResolvedEntry()` has no trip fields at all
			     (see log-entry.svelte.ts's module doc). Unchanged by A4b. -->
			<form class="log" method="POST" action="?/logTxn" use:enhance={tripSubmit(mobileTripEntry)}>
				<input type="hidden" name="clientUuid" value={mobileTripEntry.clientUuid} />

				<label class="amount">
					<span class="sr-only">Amount spent</span>
					<span class="amount-sym" aria-hidden="true">{view.trip.currency.symbol}</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						name="amount"
						bind:value={mobileTripEntry.amount}
						type="text"
						inputmode={view.trip.currency.minorUnits === 0 ? 'numeric' : 'decimal'}
						autocomplete="off"
						autocorrect="off"
						spellcheck="false"
						placeholder="0"
						autofocus
					/>
				</label>

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

				<fieldset class="chips">
					<legend class="sr-only">Category</legend>
					{#each CATEGORIES as cat (cat.key)}
						<label class="chip" class:on={mobileTripEntry.category === cat.key}>
							<input
								type="radio"
								name="category"
								value={cat.key}
								bind:group={mobileTripEntry.category}
							/>
							{cat.label}
						</label>
					{/each}
				</fieldset>

				<fieldset class="seg">
					<legend class="sr-only">Was this planned?</legend>
					<label class="seg-opt" class:on={mobileTripEntry.planned === '1'}>
						<input type="radio" name="planned" value="1" bind:group={mobileTripEntry.planned} />
						Planned
					</label>
					<label class="seg-opt" class:on={mobileTripEntry.planned === '0'}>
						<input type="radio" name="planned" value="0" bind:group={mobileTripEntry.planned} />
						Unplanned
					</label>
				</fieldset>

				<button class="save" type="submit" disabled={!mobileTripEntry.ready}>Save entry</button>

				{#if form?.error}
					<p class="err" role="alert">{form.error}</p>
				{/if}
			</form>
		{:else}
			<!--
				One field replaces three (task A4b). The user types a word and an
				amount, in either order; the resolution line beneath states what
				the app understood and, last on the line, what it will do to
				today's number (Spec §5.6).
			-->
			{#if mobileActionId}
				<!--
					A pill was tapped on the resident field: the action's own view
					takes the field's place rather than opening the Actions panel
					(owner request). Same slot, same surface.
				-->
				<ActionView
					actionId={mobileActionId}
					context={data.actionContext}
					draft={mobileActionDraft}
					onDraftChange={(draft) => (mobileActionDraft = draft)}
					onBack={() => {
						mobileActionId = undefined;
					}}
					onSaved={() => {
						mobileActionId = undefined;
						mobileActionDraft = undefined;
						mobileEntry.reset();
						void invalidateAll();
					}}
				/>
			{:else}
				<form
					class="log"
					method="POST"
					action="?/logEntry"
					bind:this={mobileFormEl}
					use:enhance={offlineLogSubmit(
						mobileEntry,
						() => mobileResolved,
						data.userId,
						undefined,
						refreshQueuedCount
					)}
				>
					<input type="hidden" name="clientUuid" value={mobileEntry.clientUuid} />
					<input type="hidden" name="planned" value={mobileEntry.planned} />
					<input type="hidden" name="commitmentMode" value={mobileEntry.commitmentMode} />
					<input type="hidden" name="taughtWord" value={mobileEntry.taughtWord} />
					<input type="hidden" name="taughtEnglish" value={mobileEntry.taughtEnglish} />
					<input type="hidden" name="taughtRoot" value={mobileEntry.taughtRoot} />

					<label class="entry-label" for="log-mobile">
						<span class="sr-only">What did you spend on?</span>
					</label>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						id="log-mobile"
						class="entry-field"
						name="text"
						bind:value={mobileEntry.text}
						type="text"
						autocomplete="off"
						autocorrect="off"
						spellcheck="false"
						placeholder="kape 65"
						oninput={() => {
							intentSequence++;
							mobileIntentLoading = false;
							mobileIntentChoices = null;
						}}
						onkeydown={(e) => {
							if (e.key === 'Enter') e.preventDefault();
						}}
						autofocus
					/>

					<!--
					Action-feature pills (user request): the catalogue's money
					operations, so opening this bar shows what else the app can do
					besides logging spending — one tap hands off to the shared
					panel, preset to that action. Hidden the moment there is text,
					exactly like autocomplete suggestions.
				-->
					{#if mobileEntry.text.trim() === ''}
						<div class="sugg-row">
							{#each ACTION_PILLS as p (p.id)}
								<button
									type="button"
									class="sugg-pill sugg-pill--action"
									onclick={() => openActionFromPill(p.id)}
								>
									{p.label}
								</button>
							{/each}
						</div>
					{/if}

					<EntryResolution
						entry={mobileEntry}
						resolved={mobileResolved}
						minorUnits={view.currency.minorUnits}
						symbol={view.currency.symbol}
						onSubmit={submitMobileEntry}
						onContinue={() => continueTypedRequest(false)}
						onChooseAction={(id) => openIntentAction(id, false, mobileEntry.text.trim())}
						intentLoading={mobileIntentLoading}
						intentChoices={mobileIntentChoices}
					/>

					{#if form?.error}
						<p class="err" role="alert">{form.error}</p>
					{/if}
				</form>
			{/if}

			<!--
				The offline outbox's queue (Spec §6, task A5). Part of the log form,
				not a new Today widget — Today's widget list is closed (Spec §8.1) —
				so this renders only while something is actually waiting and
				disappears entirely the moment the queue is empty. A COUNT, never a
				sum of money: Invariant 1 applies here exactly as it applies to the
				band above.
			-->
			{#if queuedCount > 0}
				<p class="queue-note" role="status">
					{queuedCount === 1 ? '1 entry waiting to send' : `${queuedCount} entries waiting to send`}
				</p>
				{#if queueStuck}
					<!--
						Refused, not merely waiting. Some refusals never resolve on
						their own, so a count alone would sit there looking patient
						while nothing was being saved.
					-->
					<p class="queue-stuck" role="alert">
						Refused: {queueStuck}
					</p>
				{/if}
			{/if}
		{/if}

		<!--
			The door (Spec §9).

			Every dense screen in this app existed and the owner never found one:
			`NavStrip` is deliberately absent from Today, so the only way in was
			typing a URL. When finally shown the destinations he could not tell
			what "Irregulars", "Rules" or "Money map" were — which is a naming
			failure, not a user failure, and §5.12 fixed the words.

			This is a disclosure, not a nav bar. `NavStrip`'s own comment is right
			that a permanent nav on Today is an invitation to go looking for
			balances, and the whole withholding layer exists to prevent that. So it
			sits below the log form, collapsed, one quiet line — and each
			destination carries a short line saying what it holds, because a name
			alone was what failed the first time.

			`todayView()` gains no field for this.
		-->
		<div class="door-strip">
			<NavStrip />
		</div>
	</main>

	<LogOverlay
		tripEntry={desktopTripEntry}
		entry={desktopEntry}
		bind:open={overlayOpen}
		currency={view.currency}
		tripCurrency={view.trip ? view.trip.currency : null}
		{homeEquivalent}
		ctx={parseContext}
		entries={view.entries}
		userId={data.userId}
		{queuedCount}
		onQueueChanged={refreshQueuedCount}
		onClose={() => {
		intentSequence++;
		desktopIntentLoading = false;
		overlayOpen = false;
	}}
		{onTripSaved}
		onEntrySaved={onDesktopEntrySaved}
		onActionPill={openActionFromPill}
		{actionId}
		actionDraft={desktopActionDraft}
		onActionDraftChange={(draft) => (desktopActionDraft = draft)}
		onContinue={() => continueTypedRequest(true)}
		onTextChanged={() => {
		intentSequence++;
		desktopIntentLoading = false;
		desktopIntentChoices = null;
	}}
		onChooseAction={(id) => openIntentAction(id, true, desktopEntry.text.trim())}
		intentLoading={desktopIntentLoading}
		intentChoices={desktopIntentChoices}
		actionContext={data.actionContext}
		onActionBack={() => (actionId = undefined)}
		onActionSaved={() => {
			actionId = undefined;
			desktopActionDraft = undefined;
			desktopEntry.reset();
			overlayOpen = false;
			void invalidateAll();
		}}
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

	.setup-go {
		display: inline-flex;
		align-items: center;
		min-height: var(--touch);
		padding: 0 1rem;
		margin-top: 0.75rem;
		background: var(--accent-solid);
		color: #fff;
		border-radius: 0.5rem;
		text-decoration: none;
		font-weight: 600;
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

	/* Spec §7.4's "I cancelled it" / undo, attached to the subscriptionDue
	   line rather than a new widget. */
	.sub-due-cancel {
		display: inline-flex;
		margin-left: auto;
	}

	.mini {
		padding: 0.2rem 0.55rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 0.6875rem;
		cursor: pointer;
	}

	.mini:hover {
		border-color: var(--ink-secondary);
		color: var(--ink);
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

	.flag.refund-flag {
		color: var(--success, #1a7f4b);
		margin-right: 0.5rem;
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

	/*
	 * The typed entry (task A4b, non-trip only). One field, sans-serif —
	 * `EntryResolution` beneath it is what turns mono, the split that is the
	 * design's whole signature (Spec §5.6).
	 */
	.entry-field {
		width: 100%;
		min-height: var(--touch);
		padding: 0.6rem 0.75rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		color: var(--ink);
		font-family: var(--font-ui);
		font-size: 1.0625rem;
	}

	.entry-field::placeholder {
		color: var(--ink-muted);
	}

	.entry-field:focus {
		outline: none;
		border-color: var(--accent);
	}

	/* ── Action-feature pills under the typing bar (user request) ─────────
	   The catalogue's money operations, one tap each into the shared panel;
	   hidden once there is text in the field, like autocomplete
	   suggestions. */
	.sugg-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.5rem;
	}

	.sugg-pill {
		font: inherit;
		font-size: 0.8125rem;
		padding: 0.2rem 0.65rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--ink-secondary);
		cursor: pointer;
	}

	.sugg-pill:active {
		border-color: var(--accent);
		color: var(--ink);
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

	/* ── Catch-up rows (Spec §4.6) ───────────────────────────────────────
	   One row per missed day. Deliberately plain: this is a chore, and dressing
	   it up would make it look like something you are meant to enjoy. */

	.missed-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--hairline);
	}

	.missed-row:last-child {
		border-bottom: 0;
	}

	.missed-day {
		flex: 0 0 4.5rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--ink-muted);
	}

	.missed-text {
		flex: 1 1 8rem;
		min-height: var(--touch);
		padding: 0.4rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		color: var(--ink);
		font-family: var(--font-ui);
		font-size: 0.9375rem;
	}

	.missed-file,
	.missed-alt {
		min-height: var(--touch);
		padding: 0 0.7rem;
		border-radius: 0.375rem;
		font-family: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.missed-file {
		background: var(--surface);
		border: 1px solid var(--ink-muted);
		color: var(--ink);
	}

	.missed-alt {
		background: none;
		border: 1px solid var(--hairline-strong);
		color: var(--ink-muted);
	}

	.missed-file:hover,
	.missed-alt:hover {
		border-color: var(--ink);
		color: var(--ink);
	}

	.queue-stuck {
		margin: 0.25rem 0 0;
		color: var(--critical-text, #ef7b7b);
		font-size: 0.8125rem;
	}


	/* ── The destination strip ──────────────────────────────────────────
	   Spacing only. The strip itself is `NavStrip`, which owns its own look so
	   every screen gets the identical row; see that component for why the rule
	   sits above it here and below it everywhere else. */
	.door-strip {
		margin-top: 1.5rem;
	}

	/* ── Offline outbox queue note (Spec §6, task A5) ────────────────────
	   Quiet by design: this is a status line, not a prompt — it never gets
	   a border or a background the way `.prompt` does, and it vanishes
	   entirely rather than reading "0 entries waiting" when idle. */
	.queue-note {
		margin: -0.5rem 0 0;
		color: var(--ink-muted);
		font-size: 0.8125rem;
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

	/* The toast belongs to the desktop shell only. */
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
	}
</style>
