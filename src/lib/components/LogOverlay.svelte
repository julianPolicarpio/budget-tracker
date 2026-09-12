<script lang="ts">
	/**
	 * The desktop log overlay.
	 *
	 * On a wide screen a resident form makes Today read as a data-entry app and
	 * competes with the hero, which §8.0b.2 forbids outright. So the form is
	 * summoned instead — and summoning it costs nothing, because any digit
	 * opens it with that digit already in the amount. §8.1.2's "never behind a
	 * tap" is about thumb reach in bed; on a keyboard the equivalent is that it
	 * opens on the first character of the thing you were going to type anyway.
	 */
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { CATEGORIES } from '$lib/categories';
	import { formatMoney } from '$lib/money';
	import { logSubmit, type EntrySnapshot, type LogEntry } from '$lib/log-entry.svelte';

	interface Props {
		entry: LogEntry;
		open: boolean;
		currency: { symbol: string; minorUnits: number };
		/** Trip currency when one is active — the keypad follows the price tag. */
		tripCurrency?: { symbol: string; minorUnits: number } | null;
		homeEquivalent?: number | null;
		entries: {
			id: number;
			amountMinor: number;
			amountLocalMinor: number | null;
			category: string;
			planned: boolean;
		}[];
		onClose: () => void;
		onSaved: (s: EntrySnapshot) => void;
	}

	let {
		entry,
		open = $bindable(),
		currency,
		tripCurrency = null,
		homeEquivalent = null,
		entries,
		onClose,
		onSaved
	}: Props = $props();

	const keypad = $derived(tripCurrency ?? currency);

	let amountEl = $state<HTMLInputElement | undefined>();
	/**
	 * Which row the keyboard is driving. Digits build the amount while it is
	 * `amount`; the 1–8 category shortcuts only bind once there is an amount to
	 * attach them to, which is what stops a leading "2" being read as Food out.
	 */
	let mode = $state<'amount' | 'category'>('amount');

	$effect(() => {
		if (open) {
			mode = 'amount';
			queueMicrotask(() => amountEl?.focus());
		}
	});

	function toCategoryMode() {
		if (entry.amount.trim() === '') return;
		mode = 'category';
		amountEl?.blur();
	}

	function toAmountMode() {
		mode = 'amount';
		queueMicrotask(() => amountEl?.focus());
	}

	function cycleCategory(step: number) {
		const i = CATEGORIES.findIndex((c) => c.key === entry.category);
		const next = (i + step + CATEGORIES.length) % CATEGORIES.length;
		entry.category = CATEGORIES[i === -1 && step > 0 ? 0 : next].key;
	}

	let formEl = $state<HTMLFormElement | undefined>();

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
	async function save() {
		await tick();
		if (entry.ready) formEl?.requestSubmit();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
			return;
		}

		// P and U set the flag AND save, from either row. They are intercepted
		// even inside the amount field, which is a number field anyway.
		const letter = event.key.toLowerCase();
		if ((letter === 'p' || letter === 'u') && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			entry.planned = letter === 'p' ? '1' : '0';
			void save();
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			void save();
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
				entry.category = CATEGORIES[Number(event.key) - 1].key;
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

	<div class="panel" data-motion="fade" role="dialog" aria-modal="true" aria-label="Log an entry">
		<form
			bind:this={formEl}
			method="POST"
			action="?/logTxn"
			use:enhance={logSubmit(entry, onSaved)}
		>
			<input type="hidden" name="clientUuid" value={entry.clientUuid} />

			<!-- Amount -->
			<label class="amount-row">
				<span class="sr-only">Amount spent</span>
				<span class="prefix" aria-hidden="true">{keypad.symbol}</span>
				<input
					bind:this={amountEl}
					bind:value={entry.amount}
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

			{#if tripCurrency}
				<p class="equiv" aria-live="polite">
					{homeEquivalent !== null
						? `≈ ${money(homeEquivalent, currency)} at the rate you locked`
						: 'Home equivalent appears as you type'}
				</p>
			{/if}

			<!-- Categories, badged with their shortcut -->
			<fieldset class="chips" class:armed={mode === 'category'}>
				<legend class="sr-only">Category</legend>
				{#each CATEGORIES as cat, i (cat.key)}
					<label class="chip" class:on={entry.category === cat.key}>
						<input type="radio" name="category" value={cat.key} bind:group={entry.category} />
						<span class="badge">{i + 1}</span>
						{cat.label}
					</label>
				{/each}
			</fieldset>

			<!-- Planned / unplanned -->
			<fieldset
				class="seg"
				class:armed={entry.amount.trim() !== '' && entry.category !== '' && entry.planned === ''}
			>
				<legend class="sr-only">Was this planned?</legend>
				<label class="seg-opt" class:on={entry.planned === '1'}>
					<input type="radio" name="planned" value="1" bind:group={entry.planned} />
					<span class="badge">P</span> Planned
				</label>
				<label class="seg-opt" class:on={entry.planned === '0'}>
					<input type="radio" name="planned" value="0" bind:group={entry.planned} />
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

			<button class="sr-only" type="submit" disabled={!entry.ready}>Save entry</button>
		</form>

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

	/* ── Amount ───────────────────────────────────────────────────────── */
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
		font-family: inherit;
		font-size: 46px;
		line-height: 1.05;
		font-variant-numeric: proportional-nums;
		caret-color: var(--accent);
		padding: 0;
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

	/* ── Chips ────────────────────────────────────────────────────────── */
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
