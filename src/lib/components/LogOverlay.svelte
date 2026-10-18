<script lang="ts">
	/**
	 * The desktop log overlay.
	 *
	 * On a wide screen a resident form makes Today read as a data-entry app and
	 * competes with the hero, which §8.0b.2 forbids outright. So the form is
	 * summoned instead — and summoning it costs nothing, because any digit
	 * opens it with that digit already in the amount/text. §8.1.2's "never
	 * behind a tap" is about thumb reach in bed; on a keyboard the equivalent
	 * is that it opens on the first character of the thing you were going to
	 * type anyway.
	 *
	 * Two forms live here (see `log-entry.svelte.ts`'s module doc for why):
	 * the NEW typed entry (task A4b) when no trip is active, and the OLD
	 * amount/category/planned form — unchanged — while a trip is, because
	 * A4a's router has no trip fields at all.
	 */
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { CATEGORIES } from '$lib/categories';
	import { formatMoney } from '$lib/money';
	import type { ParseContext, ParsedEntry } from '$lib/entry-parser';
	import {
		offlineLogSubmit,
		resolveLive,
		tripSubmit,
		LogEntry,
		TripEntry,
		type TripSnapshot
	} from '$lib/log-entry.svelte';
	import EntryResolution from './EntryResolution.svelte';
	import ActionView from './actions/ActionView.svelte';
	import { ACTION_PILLS } from '$lib/actions/catalogue';
	import { demoVisibleActionIds } from '$lib/actions/action-view';
	import { page } from '$app/state';
	import type { ActionContext } from '$lib/actions/context';
	import type { ActionDraft } from '$lib/actions/draft';

	interface Props {
		tripEntry: TripEntry;
		entry: LogEntry;
		open: boolean;
		currency: { symbol: string; minorUnits: number };
		/** Trip currency when one is active — the keypad follows the price tag,
		 * and its presence is what switches this overlay to the OLD form. */
		tripCurrency?: { symbol: string; minorUnits: number } | null;
		homeEquivalent?: number | null;
		/** The typed-entry router's context (Spec §5.6-§5.7) — unused while a
		 * trip is active. */
		ctx: ParseContext;
		entries: {
			id: number;
			amountMinor: number;
			amountLocalMinor: number | null;
			category: string;
			planned: boolean;
		}[];
		/** Namespaces the offline outbox (Spec §6, task A5) — unused while a
		 * trip is active, same as `ctx`, since trips still log through the
		 * pre-A4 form which is not wired to the outbox. */
		userId: number;
		/** How many entries are queued right now, shared with `+page.svelte`
		 * so the mobile shell and this overlay never show two different
		 * counts for one outbox. */
		queuedCount: number;
		onQueueChanged: () => void;
		onClose: () => void;
		onTripSaved: (s: TripSnapshot) => void;
		onEntrySaved: (s: ParsedEntry) => void;
		/** Optional: whole-operation action pills (Record income, Transfer
		 * money, Record a payment) rendered alongside the commitment pills.
		 * Absent in embedders with no host page to hand off to (tests). */
		onActionPill?: (actionId: string) => void;
		/** The action the bar has switched to (a pill was tapped), or
		 * undefined while this is the typing bar itself. The two states are one
		 * surface (owner request: seamless transition), so an action swaps this
		 * panel's *content* rather than closing it and opening a second
		 * overlay. */
		actionId?: string;
		/** Today's action context — what an action's own form needs
		 * (accounts, refundable). Absent in embedders with no action view. */
		actionContext?: ActionContext;
		/** Back to the typing bar; the host owns that state. */
		onActionBack?: () => void;
		/** The action's form recorded something: the host closes the surface. */
		onActionSaved?: () => void;
		actionDraft?: ActionDraft;
		onActionDraftChange?: (draft: ActionDraft) => void;
		onContinue?: () => void;
		onTextChanged?: () => void;
		onChooseAction?: (id: string) => void;
		intentLoading?: boolean;
		intentChoices?: { source: string; ids: string[] } | null;
	}

	let {
		tripEntry,
		entry,
		open = $bindable(),
		currency,
		tripCurrency = null,
		homeEquivalent = null,
		ctx,
		entries,
		userId,
		queuedCount,
		onQueueChanged,
		onClose,
		onTripSaved,
		onEntrySaved,
		/** Picking an action-feature pill hands the id to the host, which
		 * decides what that action means (a form here, or a tab to navigate
		 * to) and passes it back as `actionId` — this overlay never opens a
		 * second surface of its own. */
		onActionPill,
		actionId,
		actionContext,
		onActionBack,
		onActionSaved,
		actionDraft,
		onActionDraftChange,
		onContinue,
		onTextChanged,
		onChooseAction,
		intentLoading,
		intentChoices
	}: Props = $props();

	const keypad = $derived(tripCurrency ?? currency);
	const resolved = $derived(resolveLive(entry, ctx, currency.minorUnits));

	let tripAmountEl = $state<HTMLInputElement | undefined>();
	let textEl = $state<HTMLInputElement | undefined>();
	let formEl = $state<HTMLFormElement | undefined>();

	/**
	 * Which row the keyboard is driving, TRIP FORM ONLY. Digits build the
	 * amount while it is `amount`; the 1–8 category shortcuts only bind once
	 * there is an amount to attach them to, which is what stops a leading "2"
	 * being read as Food out. The new typed field has no such mode: every
	 * character is just more of the sentence.
	 */
	let mode = $state<'amount' | 'category'>('amount');

	$effect(() => {
		// Not while an action view is up: that view focuses its own first
		// field, and pulling focus back to the entry input hidden behind it
		// would leave the keyboard typing into something nobody can see.
		if (open && !actionId) {
			mode = 'amount';
			queueMicrotask(() => (tripCurrency ? tripAmountEl : textEl)?.focus());
		}
	});

	function toCategoryMode() {
		if (tripEntry.amount.trim() === '') return;
		mode = 'category';
		tripAmountEl?.blur();
	}

	function toAmountMode() {
		mode = 'amount';
		queueMicrotask(() => tripAmountEl?.focus());
	}

	function cycleCategory(step: number) {
		const i = CATEGORIES.findIndex((c) => c.key === tripEntry.category);
		const next = (i + step + CATEGORIES.length) % CATEGORIES.length;
		tripEntry.category = CATEGORIES[i === -1 && step > 0 ? 0 : next].key;
	}

	/**
	 * Always await the flush before submitting.
	 *
	 * P and U set the flag and save in one keystroke, and Svelte applies state
	 * to the DOM asynchronously. Submitting in the same tick serialises the
	 * radio group as it was *before* the keypress — so pressing P recorded
	 * `unplanned`, and the toast cheerfully confirmed "planned" back, because it
	 * reads the state object rather than the form. Silent, and on the single
	 * most diagnostic flag in the app.
	 */
	async function saveTrip() {
		await tick();
		if (tripEntry.ready) formEl?.requestSubmit();
	}

	/** The typed entry's one save path: every action button in
	 * `EntryResolution` both chooses AND saves — this is what it calls after
	 * setting the relevant field. */
	async function submitEntry() {
		await tick();
		formEl?.requestSubmit();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}

		// The rest of this handler is the OLD trip-form keyboard scheme. The
		// typed field takes free text — any of "p", "u", "1".."8" or Tab may be
		// part of a word the user is typing, so none of them can be
		// intercepted globally the way the trip form's dedicated fields allow.
		if (!tripCurrency) return;

		const letter = event.key.toLowerCase();
		if ((letter === 'p' || letter === 'u') && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			tripEntry.planned = letter === 'p' ? '1' : '0';
			void saveTrip();
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			void saveTrip();
			return;
		}

		if (event.key === 'Tab') {
			event.preventDefault();
			if (mode === 'amount') toCategoryMode();
			else cycleCategory(event.shiftKey ? -1 : 1);
			return;
		}

		if (mode === 'category') {
			if (/^[1-8]$/.test(event.key)) {
				event.preventDefault();
				tripEntry.category = CATEGORIES[Number(event.key) - 1].key;
				return;
			}
			if (event.key === 'Backspace') {
				event.preventDefault();
				toAmountMode();
			}
		}
	}

	function money(minor: number, c: { symbol: string; minorUnits: number }): string {
		return formatMoney(minor, { minorUnits: c.minorUnits, symbol: c.symbol });
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<!--
		The hero is not unmounted behind this — it blurs and dims, so the number
		you came to check is still the thing on screen.
	-->
	<div
		class="scrim"
		data-motion="fade"
		role="presentation"
		onclick={onClose}
		onkeydown={() => {}}
	></div>

	<div
		class="panel"
		data-motion="fade"
		role="dialog"
		aria-modal="true"
		aria-label={actionId ? 'Record an action' : 'Log an entry'}
	>
		{#if actionId && actionContext && onActionBack && onActionSaved}
			<!--
				An action-feature pill was tapped: same panel, same place, same
				animation — only the content changes, which is the point of the
				hand-off (owner request: seamless transition). A sibling of the
				entry form, never inside it: these forms are <form> elements
				themselves, and nesting them is invalid HTML.
			-->
			<ActionView
				{actionId}
				context={actionContext}
				draft={actionDraft}
				onDraftChange={onActionDraftChange}
				onBack={onActionBack}
				onSaved={onActionSaved}
			/>
		{:else if tripCurrency}
			<form
				bind:this={formEl}
				method="POST"
				action="?/logTxn"
				use:enhance={tripSubmit(tripEntry, onTripSaved)}
			>
				<input type="hidden" name="clientUuid" value={tripEntry.clientUuid} />

				<!-- Amount -->
				<label class="amount-row">
					<span class="sr-only">Amount spent</span>
					<span class="prefix" aria-hidden="true">{keypad.symbol}</span>
					<input
						bind:this={tripAmountEl}
						bind:value={tripEntry.amount}
						name="amount"
						type="text"
						inputmode={keypad.minorUnits === 0 ? 'numeric' : 'decimal'}
						autocomplete="off"
						autocorrect="off"
						spellcheck="false"
						placeholder="0"
						onfocus={() => (mode = 'amount')}
					/>
				</label>

				<p class="equiv" aria-live="polite">
					{homeEquivalent !== null
						? `≈ ${money(homeEquivalent, currency)} at the rate you locked`
						: 'Home equivalent appears as you type'}
				</p>

				<!-- Categories, badged with their shortcut -->
				<fieldset class="chips" class:armed={mode === 'category'}>
					<legend class="sr-only">Category</legend>
					{#each CATEGORIES as cat, i (cat.key)}
						<label class="chip" class:on={tripEntry.category === cat.key}>
							<input type="radio" name="category" value={cat.key} bind:group={tripEntry.category} />
							<span class="badge">{i + 1}</span>
							{cat.label}
						</label>
					{/each}
				</fieldset>

				<!-- Planned / unplanned -->
				<fieldset
					class="seg"
					class:armed={tripEntry.amount.trim() !== '' &&
						tripEntry.category !== '' &&
						tripEntry.planned === ''}
				>
					<legend class="sr-only">Was this planned?</legend>
					<label class="seg-opt" class:on={tripEntry.planned === '1'}>
						<input type="radio" name="planned" value="1" bind:group={tripEntry.planned} />
						<span class="badge">P</span> Planned
					</label>
					<label class="seg-opt" class:on={tripEntry.planned === '0'}>
						<input type="radio" name="planned" value="0" bind:group={tripEntry.planned} />
						<span class="badge">U</span> Unplanned
					</label>
				</fieldset>

				<div class="hint">
					<span><kbd>0–9</kbd> amount</span>
					<span><kbd>Tab</kbd> {mode === 'amount' ? 'to categories' : 'next category'}</span>
					<span><kbd>1–8</kbd> category</span>
					<span><kbd>P</kbd>/<kbd>U</kbd> flag and save</span>
					<span><kbd>Esc</kbd> cancel</span>
				</div>

				<button class="sr-only" type="submit" disabled={!tripEntry.ready}>Save entry</button>
			</form>
		{:else}
			<form
				bind:this={formEl}
				data-tour="entry"
				method="POST"
				action="?/logEntry"
				use:enhance={offlineLogSubmit(entry, () => resolved, userId, onEntrySaved, onQueueChanged)}
			>
				<input type="hidden" name="clientUuid" value={entry.clientUuid} />
				<input type="hidden" name="planned" value={entry.planned} />
				<input type="hidden" name="commitmentMode" value={entry.commitmentMode} />
				<input type="hidden" name="taughtWord" value={entry.taughtWord} />
				<input type="hidden" name="taughtEnglish" value={entry.taughtEnglish} />
				<input type="hidden" name="taughtRoot" value={entry.taughtRoot} />

				<label class="amount-row">
					<span class="sr-only">What did you spend on?</span>
					<input
						bind:this={textEl}
						bind:value={entry.text}
						name="text"
						type="text"
						autocomplete="off"
						autocorrect="off"
						spellcheck="false"
						placeholder="kape 65"
						oninput={onTextChanged}
						onkeydown={(e) => {
							if (e.key === 'Enter') e.preventDefault();
						}}
					/>
				</label>

				<!--
					Action-feature pills (user request): the catalogue's money
					operations, so opening this bar shows what else the app can
					do besides logging spending — the same set the mobile shell's
					row renders, one tap into the action's own view below.
				-->
				{#if entry.text.trim() === '' || /^\s*\d+$/.test(entry.text)}
					{#if onActionPill}
						<div class="sugg-row">
							<!-- Action-feature pills (user request): the catalogue's
							     money operations, so what else this bar can do is visible
							     without leaving it. Tapping one hands the id to the host
							     page, which passes it back as `actionId` — this panel then
							     swaps its content to that action (see the `actionId` branch
							     above), so the bar and the action are one surface. Skipped
							     in embedders with no onActionPill (tests, other tabs). -->
							{#each page.data.demo === true ? ACTION_PILLS.filter((p) => demoVisibleActionIds([p.id], true).length === 1) : ACTION_PILLS as p (p.id)}
								<button
									type="button"
									class="sugg-pill sugg-pill--action"
									onclick={() => onActionPill(p.id)}
								>
									{p.label}
								</button>
							{/each}
						</div>
					{/if}
				{/if}

			<EntryResolution
					{entry}
					{resolved}
					minorUnits={currency.minorUnits}
					symbol={currency.symbol}
				onSubmit={submitEntry}
				{onContinue}
				{onChooseAction}
				{intentLoading}
				{intentChoices}
				/>

				<!-- The offline outbox's queue (Spec §6, task A5) — same rule as
				     the mobile shell's copy of this line: a count, never money,
				     and absent entirely once nothing is waiting. -->
				{#if queuedCount > 0}
					<p class="queue-note" role="status">
						{queuedCount === 1
							? '1 entry waiting to send'
							: `${queuedCount} entries waiting to send`}
					</p>
				{/if}

				<p class="hint"><span><kbd>Esc</kbd> cancel</span></p>
			</form>
		{/if}

		{#if entries.length > 0}
			<!-- Today's entries live here rather than on the idle screen, so the
			     hero keeps the screen to itself. -->
			<ul class="today">
				{#each entries as e (e.id)}
					<li>
						<span>{CATEGORIES.find((c) => c.key === e.category)?.label}</span>
						{#if !e.planned}<span class="flag">unplanned</span>{/if}
						<span class="amt">
							{e.amountLocalMinor !== null && tripCurrency
								? money(e.amountLocalMinor, tripCurrency)
								: money(e.amountMinor, currency)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: color-mix(in srgb, var(--ground) 55%, transparent);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		animation: fade 140ms ease-out;
	}

	/*
	 * Not vertically centred: at 26vh the panel sits under where the eye
	 * already is and leaves the hero visible above it.
	 */
	.panel {
		position: fixed;
		z-index: 41;
		top: 26vh;
		left: 50%;
		width: min(620px, calc(100vw - 3rem));
		transform: translateX(-50%);
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.875rem;
		box-shadow: 0 24px 60px -12px rgb(0 0 0 / 0.55);
		padding: 1.25rem;
		animation: rise 160ms cubic-bezier(0.2, 0, 0, 1);
	}

	@keyframes fade {
		from {
			opacity: 0;
		}
	}

	/* Movement lives in `translate`/`scale`, not `transform`, so the
	   reduced-motion rule can drop it and leave the centring alone. */
	@keyframes rise {
		from {
			opacity: 0;
			translate: 0 8px;
			scale: 0.985;
		}
	}

	.panel form {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	/* ── Amount / text row ────────────────────────────────────────────── */
	.amount-row {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--hairline);
	}

	.prefix {
		font-size: 1.375rem;
		color: var(--ink-muted);
	}

	.amount-row input {
		flex: 1 1 auto;
		width: 100%;
		background: none;
		border: 0;
		color: var(--ink);
		font-family: var(--font-ui);
		font-size: 46px;
		line-height: 1.05;
		font-variant-numeric: proportional-nums;
		caret-color: var(--accent);
		padding: 0;
		min-height: var(--touch);
	}

	.amount-row input:focus {
		outline: none;
	}

	.amount-row input::placeholder {
		color: var(--hairline-strong);
	}

	.equiv {
		margin: -0.375rem 0 0;
		font-size: 0.8125rem;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	/* ── Chips (trip form only) ───────────────────────────────────────── */
	.chips,
	.seg {
		border: 0;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	.chips {
		grid-template-columns: repeat(4, 1fr);
	}

	.seg {
		grid-template-columns: repeat(2, 1fr);
	}

	.chip,
	.seg-opt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		min-height: 2.5rem;
		padding: 0 0.5rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		color: var(--ink-secondary);
		font-size: 0.875rem;
		white-space: nowrap;
		cursor: pointer;
	}

	/* The badges only light up once their shortcut is actually live. */
	.chips.armed .badge,
	.seg.armed .badge {
		color: var(--accent);
		border-color: var(--accent);
	}

	/*
	 * Nothing defaults the flag, so once the amount and category are in, this is
	 * the only thing standing between you and a saved entry. It says so rather
	 * than letting Enter fail silently.
	 */
	.seg.armed {
		outline: 1px solid var(--accent);
		outline-offset: 3px;
		border-radius: 0.5rem;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.125rem;
		height: 1.125rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.625rem;
		color: var(--ink-muted);
	}

	.chip.on,
	.seg-opt.on {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--ground);
	}

	.chip.on .badge,
	.seg-opt.on .badge {
		color: var(--ground);
		border-color: color-mix(in srgb, var(--ground) 40%, transparent);
	}

	.chip input,
	.seg-opt input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	/* ── Action-feature pills under the typing bar (user request) ──────── */
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

	/* ── Hint bar ─────────────────────────────────────────────────────── */
	.hint {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--hairline);
		font-size: 0.75rem;
		color: var(--ink-muted);
	}

	/* ── Offline outbox queue note (Spec §6, task A5) ────────────────────
	   Same rule as `+page.svelte`'s copy: quiet, no border, absent entirely
	   once the queue is empty. */
	.queue-note {
		margin: 0.625rem 0 0;
		color: var(--ink-muted);
		font-size: 0.8125rem;
	}

	kbd {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		padding: 0.05rem 0.3rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
		color: var(--ink-secondary);
	}

	/* ── Today's entries ──────────────────────────────────────────────── */
	.today {
		list-style: none;
		margin: 1rem 0 0;
		padding: 0.875rem 0 0;
		border-top: 1px solid var(--hairline);
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.today li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--ink-secondary);
	}

	.flag {
		font-family: var(--font-mono);
		font-size: 0.5625rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.amt {
		margin-left: auto;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--ink);
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
</style>
