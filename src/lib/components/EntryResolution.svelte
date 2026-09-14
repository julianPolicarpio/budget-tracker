<script lang="ts">
	/**
	 * The resolution line, the consequence tag, the action row and the bucket
	 * chips (Spec §5.6, §5.8; task A4b). Shared by the mobile resident form
	 * and the desktop overlay so there is exactly one rendering of "what the
	 * app understood" — porting the settled prototype, not
	 * inventing a second design.
	 *
	 * Sans is what you typed (the `<input>` this sits beneath, `--font-ui`);
	 * mono is what the machine understood — this whole component included.
	 */
	import { CATEGORIES, CATEGORY_HELP, categoryLabel, type CategoryKey } from '$lib/categories';
	import { formatMoney } from '$lib/money';
	import {
		actionKindFor,
		answerAskOnce,
		answerAskRepeats,
		consequenceText,
		questionText,
		type CadenceWord,
		type LogEntry
	} from '$lib/log-entry.svelte';
	import type { ParsedEntry } from '$lib/entry-parser';

	interface Props {
		entry: LogEntry;
		resolved: ParsedEntry;
		minorUnits: number;
		symbol: string;
		/** Flushes `entry`'s state to the DOM, then submits. Every action
		 * button both CHOOSES and SAVES in one tap (Spec's "one typed string
		 * plus one tap") — there is no separate "Save" button here. */
		onSubmit: () => void;
	}

	let { entry, resolved, minorUnits, symbol, onSubmit }: Props = $props();

	function money(minor: number): string {
		return formatMoney(minor, { minorUnits, symbol });
	}

	const actionKind = $derived(actionKindFor(resolved));
	const consequence = $derived(consequenceText(resolved));
	const question = $derived(questionText(resolved));

	const CADENCE_LABEL: Record<CadenceWord, string> = {
		weekly: 'Weekly',
		fortnightly: 'Fortnightly',
		monthly: 'Monthly',
		yearly: 'Yearly'
	};

	const NEW_COMMITMENT_PERIOD: Record<string, string> = {
		weekly: 'week',
		fortnightly: 'two weeks',
		monthly: 'month',
		annual: 'year'
	};

	const CADENCE_WORDS: CadenceWord[] = ['weekly', 'fortnightly', 'monthly', 'yearly'];

	function pickRoot(word: string, english: string, root: CategoryKey) {
		entry.teach(word, english, root);
	}

	function chooseOnce() {
		entry.text = answerAskOnce(entry.text);
	}

	function chooseCadence(word: CadenceWord) {
		entry.text = answerAskRepeats(entry.text, word);
	}

	function saveTransaction(planned: '0' | '1') {
		entry.planned = planned;
		onSubmit();
	}

	function saveCommitment(mode: 'same' | 'same_essential' | 'varies') {
		entry.commitmentMode = mode;
		onSubmit();
	}

	function confirmNoWrite() {
		onSubmit();
	}

	const hasAmount = $derived(
		'amountMinor' in resolved && resolved.amountMinor !== null && resolved.amountMinor > 0
	);
</script>

<div class="resolve" aria-live="polite">
	{#if resolved.kind === 'empty'}
		<span class="hint">A word and an amount, in either order.</span>
	{:else if resolved.kind === 'need_word'}
		<span class="hint">Add a word. What was it for?</span>
	{:else if resolved.kind === 'ask_kind'}
		<span class="english">{resolved.english}</span>
		{#if resolved.amountMinor !== null}
			<span class="dot" aria-hidden="true">·</span><span class="amt">{money(resolved.amountMinor)}</span>
		{/if}
		<span class="ask">{question}</span>
		<div class="chips">
			<button type="button" onclick={chooseOnce}>Just this once</button>
			<span class="chip-label">It repeats:</span>
			{#each CADENCE_WORDS as word (word)}
				<button type="button" onclick={() => chooseCadence(word)}>{CADENCE_LABEL[word]}</button>
			{/each}
		</div>
	{:else if resolved.kind === 'ask_category'}
		<span class="unknown">{resolved.english}</span>
		{#if resolved.amountMinor !== null}
			<span class="dot" aria-hidden="true">·</span><span class="amt">{money(resolved.amountMinor)}</span>
		{/if}
		<span class="ask">{question}</span>
		<div class="chips">
			{#each CATEGORIES as cat (cat.key)}
				<button
					type="button"
					class="wide"
					onclick={() => resolved.kind === 'ask_category' && pickRoot(resolved.word, resolved.english, cat.key)}
				>
					<b>{cat.label}</b><i>{CATEGORY_HELP[cat.key]}</i>
				</button>
			{/each}
		</div>
	{:else if resolved.kind === 'transaction'}
		{#if resolved.word !== resolved.english.toLowerCase()}
			<span class="typed">{resolved.word}</span><span class="arrow" aria-hidden="true">→</span>
		{/if}
		<span class="english">{resolved.english}</span>
		<span class="dot" aria-hidden="true">·</span>
		<span class="bucket">{categoryLabel(resolved.root)}</span>
		{#if resolved.amountMinor !== null}
			<span class="dot" aria-hidden="true">·</span><span class="amt">{money(resolved.amountMinor)}</span>
		{/if}
		<span class="tag spend">{consequence}</span>
	{:else if resolved.kind === 'existing_commitment'}
		<span class="english">{resolved.commitment.label}</span>
		<span class="dot" aria-hidden="true">·</span>
		<span class="bucket">
			{resolved.commitment.kind === 'subscription'
				? resolved.commitment.essential
					? 'non-negotiable'
					: 'already a bill'
				: 'varies, already reserved'}
		</span>
		{#if resolved.amountMinor !== null}
			<span class="dot" aria-hidden="true">·</span><span class="amt">{money(resolved.amountMinor)}</span>
		{/if}
		<span class="tag safe">{consequence}</span>
	{:else if resolved.kind === 'new_commitment'}
		<span class="english">{resolved.english}</span>
		<span class="dot" aria-hidden="true">·</span>
		<span class="bucket">new bill, per {NEW_COMMITMENT_PERIOD[resolved.cadence]}</span>
		{#if resolved.amountMinor !== null}
			<span class="dot" aria-hidden="true">·</span><span class="amt">{money(resolved.amountMinor)}</span>
		{/if}
		<span class="tag safe">{consequence}</span>
	{:else if resolved.kind === 'transfer'}
		<span class="english">Moving your own money</span>
		<span class="tag safe">{consequence}</span>
	{/if}
</div>

{#if actionKind === 'transaction'}
	<div class="pu">
		<button type="button" disabled={!hasAmount} onclick={() => saveTransaction('1')}>
			<b>P</b> Planned
		</button>
		<button type="button" disabled={!hasAmount} onclick={() => saveTransaction('0')}>
			<b>U</b> Unplanned
		</button>
	</div>
{:else if actionKind === 'existing_fixed'}
	<div class="altact">
		<p class="covered">Already covered. Reserved every period, nothing to log.</p>
		<button class="altbtn" type="button" onclick={confirmNoWrite}>Got it</button>
	</div>
{:else if actionKind === 'existing_varying'}
	<div class="altact">
		<p class="covered">Recorded as what it actually cost this period.</p>
		<button class="altbtn" type="button" disabled={!hasAmount} onclick={confirmNoWrite}>Log it</button>
	</div>
{:else if actionKind === 'new_commitment'}
	<div class="altact">
		<p class="reserve-ask">Is it the same amount every time?</p>
		<div class="optcol">
			<button class="altbtn opt" type="button" disabled={!hasAmount} onclick={() => saveCommitment('same')}>
				<b>Same every time</b><i>Reserved every period.</i>
			</button>
			<button
				class="altbtn opt"
				type="button"
				disabled={!hasAmount}
				onclick={() => saveCommitment('same_essential')}
			>
				<b>Same, and non-negotiable</b><i>Reserved every period. Never asked to cancel.</i>
			</button>
			<button class="altbtn opt" type="button" disabled={!hasAmount} onclick={() => saveCommitment('varies')}>
				<b>The amount varies</b><i>Tracks what you actually pay, with padding.</i>
			</button>
		</div>
	</div>
{:else if actionKind === 'transfer'}
	<div class="altact">
		<button class="altbtn" type="button" disabled={!hasAmount} onclick={confirmNoWrite}>Got it</button>
	</div>
{/if}

<style>
	.resolve {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		min-height: 1.75rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		color: var(--ink-muted);
		font-variant-numeric: tabular-nums;
	}

	.typed {
		color: var(--ink-muted);
	}

	.english {
		color: var(--ink);
	}

	.bucket {
		color: var(--ink-secondary);
	}

	.amt,
	.unknown {
		color: var(--ink);
	}

	.unknown {
		color: var(--status-warning);
	}

	.hint,
	.ask {
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--ink-muted);
	}

	.ask {
		color: var(--status-warning);
		flex-basis: 100%;
	}

	.tag {
		font-family: var(--font-ui);
		font-size: 0.6875rem;
		padding: 0.1rem 0.4rem;
		border-radius: 0.1875rem;
		margin-left: auto;
	}

	.tag.spend {
		background: color-mix(in srgb, var(--accent) 20%, transparent);
		color: var(--ink);
	}

	.tag.safe {
		background: color-mix(in srgb, var(--status-good) 18%, transparent);
		color: var(--ink);
	}

	/* ── Question chips (inside the live resolution line) ────────────── */
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		flex-basis: 100%;
		margin-top: 0.25rem;
	}

	.chip-label {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		color: var(--ink-muted);
	}

	.chips button {
		min-height: var(--touch);
		padding: 0.25rem 0.75rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		color: var(--ink-secondary);
		font-family: var(--font-ui);
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.chips button:hover {
		color: var(--ink);
		border-color: var(--ink-muted);
	}

	.chips button.wide {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		padding: 0.5rem 0.75rem;
	}

	.chips button.wide b {
		font-weight: 500;
		color: var(--ink);
		white-space: nowrap;
	}

	.chips button.wide i {
		font-style: normal;
		font-size: 0.75rem;
		color: var(--ink-muted);
		margin-left: auto;
		text-align: right;
	}

	/* ── The action row ────────────────────────────────────────────── */
	.pu {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.875rem;
	}

	.pu button {
		flex: 1;
		min-height: var(--touch);
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		color: var(--ink-secondary);
		font-family: inherit;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.pu button:hover:not(:disabled) {
		color: var(--ink);
		border-color: var(--ink-muted);
	}

	.pu button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.pu button b {
		font-weight: 600;
		color: var(--ink);
	}

	.altact {
		margin-top: 0.875rem;
	}

	.covered {
		margin: 0 0 0.5rem;
		padding: 0.5rem 0.625rem;
		background: color-mix(in srgb, var(--status-good) 12%, transparent);
		border-radius: 0.375rem;
		color: var(--ink-secondary);
		font-size: 0.8125rem;
	}

	.reserve-ask {
		margin: 0 0 0.5rem;
		font-size: 0.8125rem;
		color: var(--status-warning);
	}

	.altbtn {
		width: 100%;
		min-height: var(--touch);
		background: var(--surface);
		border: 1px solid var(--ink-muted);
		border-radius: 0.375rem;
		color: var(--ink);
		font-family: inherit;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.altbtn:hover:not(:disabled) {
		border-color: var(--ink);
	}

	.altbtn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.optcol {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.altbtn.opt {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		min-height: var(--touch);
		padding: 0.5rem 0.75rem;
		text-align: left;
		border-color: var(--hairline-strong);
	}

	.altbtn.opt b {
		font-weight: 500;
		font-size: 0.8125rem;
	}

	.altbtn.opt i {
		font-style: normal;
		font-size: 0.75rem;
		color: var(--ink-muted);
	}
</style>
