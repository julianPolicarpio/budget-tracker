<script lang="ts">
	/**
	 * /settings — REVIEW-class (Spec §8.0b.1), not Today. It may show figures;
	 * Today may not. Reuses the shared REVIEW register from layout.css
	 * (.sheet, .card, .field, .field-input) rather than inventing a second
	 * visual language — see accounts/+page.svelte and debt/+page.svelte for
	 * the same vocabulary.
	 */
	import NavStrip from '$lib/components/NavStrip.svelte';
	import { enhance } from '$app/forms';
	import { formatMoney } from '$lib/money';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

	const minorUnits = $derived(data.ready ? data.settings.minorUnits : 2);
	const symbol = $derived(data.ready ? data.settings.currencySymbol : '');

	function money(m: number | null | undefined): string {
		if (m === null || m === undefined) return '—';
		return formatMoney(m, { minorUnits, symbol }).replace(/\.00$/, '');
	}
</script>

<svelte:head><title>Settings · Split</title></svelte:head>

{#if !data.ready}
	<main class="sheet">
		<p class="eyebrow">Not set up</p>
		<p>This account is not set up yet. <a class="ghost" href="/setup">Start here.</a></p>
	</main>
{:else}
	<main class="sheet">
		<NavStrip />

		<header class="masthead">
			<div>
				<p class="eyebrow">Settings</p>
				<h1>How Split behaves</h1>
			</div>
		</header>

		<!--
			The spending budget (Deliverable 2). supersedePeriod() is the only
			mechanism — this section is a thin form over it, never a second
			writer of an allocation.
		-->
		<section class="card">
			<p class="eyebrow">Spending budget</p>
			<p class="lede">
				Changing this closes the period you are in and opens a new one over the same dates, at
				the new amount. Nothing already logged is rewritten, and no money moves — this only
				changes the number Split shows you.
			</p>

			{#if data.period}
				<p class="muted">
					Current period: {data.period.startsOn} to {data.period.endsOn} — {money(
						data.period.spendAllocMinor
					)} to spend{#if data.band}, today's range {money(data.band.low)}–{money(
							data.band.high
						)}{/if}.
				</p>
			{:else}
				<p class="empty">No period is currently open, so there is nothing to change yet.</p>
			{/if}

			{#if form?.budgetSaved}
				<p class="ok">
					Set to {money(form.budgetAmountMinor)}, for {form.budgetWindow?.startsOn} to {form
						.budgetWindow?.endsOn}. Today's range is now {money(form.budgetBand?.low)}–{money(
						form.budgetBand?.high
					)}.
				</p>
			{/if}
			{#if form?.budgetError}<p class="error" role="alert">{form.budgetError}</p>{/if}

			<form method="POST" action="?/setBudget" use:enhance>
				<label class="field">
					<span class="field-label">New amount for this period</span>
					<span class="field-input">
						<span class="field-sym">{symbol}</span>
						<input
							name="amount"
							type="text"
							inputmode="decimal"
							value={form?.budgetRaw ?? ''}
							placeholder="0"
						/>
					</span>
				</label>
				<button class="primary" type="submit" disabled={!data.period}>Set budget</button>
			</form>
		</section>

		<!-- The knobs (Task 4). -->
		<section class="card">
			<p class="eyebrow">The knobs</p>
			<p class="muted">
				Changes here apply to the <strong>next</strong> period. The period you are in keeps the
				numbers it opened with.
			</p>

			{#if form?.saved}<p class="ok">Saved.</p>{/if}
			{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

			<form method="POST" action="?/save" use:enhance>
				<label class="field">
					<span class="field-label">Timezone</span>
					<span class="field-input">
						<input
							name="timezone"
							type="text"
							value={form?.entered?.timezone ?? data.settings.timezone}
						/>
					</span>
				</label>
				<p class="why">Decides when your day rolls over.</p>

				<div class="grid">
					<label class="field">
						<span class="field-label">Currency code</span>
						<span class="field-input">
							<input
								name="currencyCode"
								type="text"
								maxlength="3"
								value={form?.entered?.currencyCode ?? data.settings.currencyCode}
							/>
						</span>
					</label>
					<label class="field">
						<span class="field-label">Symbol</span>
						<span class="field-input">
							<input
								name="currencySymbol"
								type="text"
								value={form?.entered?.currencySymbol ?? data.settings.currencySymbol}
							/>
						</span>
					</label>
					<label class="field">
						<span class="field-label">Decimal places</span>
						<span class="field-input">
							<input
								name="minorUnits"
								type="number"
								min="0"
								max="4"
								value={form?.entered?.minorUnits ?? String(data.settings.minorUnits)}
							/>
						</span>
					</label>
				</div>
				<p class="why">The currency Split shows figures in, and how many decimal places it has.</p>
				<input type="hidden" name="roundingStep" value={data.settings.roundingStep} />

				<label class="field">
					<span class="field-label">Budget runs</span>
					<select name="periodKind" value={form?.entered?.periodKind ?? data.settings.periodKind}>
						<option value="weekly">By the week</option>
						<option value="semimonthly">Twice a month</option>
						<option value="monthly">By the month</option>
					</select>
				</label>
				<p class="why">How often a new period opens.</p>

				<label class="field">
					<span class="field-label">Week starts on</span>
					<!--
						`selected` on the option, not `value` on the select. The day is a
						number, so a `value` of `String(0)` never matched an `<option
						value={0}>`, nothing was selected, and the browser posted an empty
						string — every save died on "weekStartsOn must be 0–6, got NaN".
						The `periodKind` select above gets away with `value` only because
						both sides are already strings. Comparing here is explicit.
					-->
					<select name="weekStartsOn">
						{#each DAYS as d, i (d)}
							<option
								value={i}
								selected={i === Number(form?.entered?.weekStartsOn ?? data.settings.weekStartsOn)}
							>
								{d}
							</option>
						{/each}
					</select>
				</label>
				<p class="why">Which day starts a new week, for the weekly review.</p>

				<label class="field">
					<span class="field-label">Held back</span>
					<span class="field-input">
						<input
							name="haircutPct"
							type="number"
							min="0"
							max="100"
							value={form?.entered?.haircutPct ?? String(data.settings.haircutPct)}
						/>
						<span class="field-sym">%</span>
					</span>
				</label>
				<p class="why">
					How much of the budget is held back as a cushion, so an ordinary week does not end
					short. What is left over at the end goes to big bills.
				</p>

				<label class="field">
					<span class="field-label">Range width</span>
					<span class="field-input">
						<input
							name="bandPct"
							type="number"
							min="0"
							max="100"
							value={form?.entered?.bandPct ?? String(data.settings.bandPct)}
						/>
						<span class="field-sym">%</span>
					</span>
				</label>
				<p class="why">
					How wide the daily range is, either side of the figure. Split shows a range on purpose,
					never one precise number.
				</p>

				<button class="primary" type="submit">Save</button>
			</form>
		</section>
	</main>
{/if}

<style>
	.muted {
		color: var(--ink-muted);
		font-size: 0.8125rem;
		margin: 0;
	}

	.ok {
		color: var(--status-good);
		font-size: 0.875rem;
		margin: 0;
	}

	.why {
		margin: -0.5rem 0 0;
		font-size: 0.8125rem;
		color: var(--ink-muted);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
	}
</style>
