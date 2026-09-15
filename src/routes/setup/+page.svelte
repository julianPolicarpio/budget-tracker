<script lang="ts">
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/* Detected, never applied silently — a browser locale says where the
	   browser thinks it is, not where the user is paid. */
	const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

	const CURRENCIES = [
		{ code: 'PHP', symbol: '₱', minorUnits: 2 },
		{ code: 'USD', symbol: '$', minorUnits: 2 },
		{ code: 'EUR', symbol: '€', minorUnits: 2 },
		{ code: 'GBP', symbol: '£', minorUnits: 2 },
		{ code: 'JPY', symbol: '¥', minorUnits: 0 },
		{ code: 'KRW', symbol: '₩', minorUnits: 0 },
		{ code: 'SGD', symbol: 'S$', minorUnits: 2 },
		{ code: 'AUD', symbol: 'A$', minorUnits: 2 }
	];

	let currencyCode = $state('PHP');
	let cadence = $state('monthly');
	let periodKind = $state('monthly');

	const currency = $derived(CURRENCIES.find((c) => c.code === currencyCode) ?? CURRENCIES[0]);

	const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
</script>

<svelte:head><title>Set up · Split</title></svelte:head>

<main class="setup-shell">
	<h1>Five questions</h1>
	<p class="lede">
		Then Split can show you a daily number. It works out the number from what you earn — you never
		have to guess an allowance.
	</p>

	<form method="POST" action="?/complete">
		<section>
			<h2>Where you are</h2>
			<label for="timezone">Timezone</label>
			<input id="timezone" name="timezone" value={detectedTz} />
			<p class="why">Decides when your day rolls over. Detected from this browser.</p>
		</section>

		<section>
			<h2>Your money</h2>
			<label for="currencyCode">Currency</label>
			<select id="currencyCode" name="currencyCode" bind:value={currencyCode}>
				{#each CURRENCIES as c (c.code)}
					<option value={c.code}>{c.symbol} {c.code}</option>
				{/each}
			</select>
			<input type="hidden" name="currencySymbol" value={currency.symbol} />
			<input type="hidden" name="minorUnits" value={currency.minorUnits} />
			{#if form?.field === 'currency'}<p class="err">{form.error}</p>{/if}
		</section>

		<section>
			<h2>What you're paid</h2>
			<label for="label">Call it</label>
			<input id="label" name="label" placeholder="Salary" />
			{#if form?.field === 'label'}<p class="err">{form.error}</p>{/if}

			<label for="amount">How much arrives each time</label>
			<input id="amount" name="amount" inputmode="decimal" placeholder="0" />
			{#if form?.field === 'amount'}<p class="err">{form.error}</p>{/if}

			<label for="cadence">How often</label>
			<select id="cadence" name="cadence" bind:value={cadence}>
				{#each data.cadences as c (c.value)}
					<option value={c.value}>{c.label}</option>
				{/each}
			</select>
			<p class="why">
				"2 weeks" and "Twice a month" are not the same thing — 26 arrivals a year against 24. Pick
				the one that matches your payslip.
			</p>

			<label for="anchorOn">Next one arrives</label>
			<input id="anchorOn" name="anchorOn" type="date" />
			{#if form?.field === 'anchorOn'}<p class="err">{form.error}</p>{/if}

			{#if cadence === 'semimonthly'}
				<label for="secondDay">And the other day of the month</label>
				<input id="secondDay" name="secondDay" type="number" min="1" max="31" />
				{#if form?.field === 'secondDay'}<p class="err">{form.error}</p>{/if}
			{/if}
		</section>

		<section>
			<h2>Your fixed bills</h2>
			<label for="bills">Roughly, per month</label>
			<input id="bills" name="bills" inputmode="decimal" placeholder="0" />
			<p class="why">
				Rent, utilities, the things that arrive every month whatever you do. A rough figure is fine
				— you can list them properly later. Without it, Split would tell you that you can spend your
				whole paycheque.
			</p>
			{#if form?.field === 'bills'}<p class="err">{form.error}</p>{/if}
		</section>

		<section>
			<h2>Your rhythm</h2>
			<label for="periodKind">Budget runs</label>
			<select id="periodKind" name="periodKind" bind:value={periodKind}>
				<option value="weekly">By the week</option>
				<option value="semimonthly">Twice a month</option>
				<option value="monthly">By the month</option>
			</select>

			<label for="weekStartsOn">Week starts on</label>
			<select id="weekStartsOn" name="weekStartsOn">
				{#each DAYS as d, i (d)}
					<option value={i} selected={i === 0}>{d}</option>
				{/each}
			</select>
		</section>

		{#if form?.error && !form?.field}<p class="err">{form.error}</p>{/if}
		<button type="submit">Show me my number</button>
	</form>
</main>

<style>
	.setup-shell {
		max-width: 32rem;
		margin: 0 auto;
		padding: 2rem 1rem 4rem;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0 0 0.5rem;
	}
	.lede {
		color: var(--ink-secondary);
		margin: 0 0 2rem;
	}
	section {
		border-top: 1px solid var(--hairline);
		padding: 1.5rem 0;
	}
	h2 {
		font-size: 0.8125rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--ink-muted);
		margin: 0 0 1rem;
	}
	label {
		display: block;
		margin: 1rem 0 0.375rem;
		color: var(--ink-secondary);
		font-size: 0.9375rem;
	}
	input,
	select {
		width: 100%;
		min-height: var(--touch);
		padding: 0 0.75rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
		color: var(--ink);
		font: inherit;
	}
	.why {
		margin: 0.5rem 0 0;
		font-size: 0.875rem;
		color: var(--ink-muted);
	}
	.err {
		margin: 0.375rem 0 0;
		font-size: 0.875rem;
		color: var(--status-critical);
	}
	button {
		width: 100%;
		min-height: var(--touch);
		margin-top: 2rem;
		background: var(--accent-solid);
		color: #fff;
		border: 0;
		border-radius: 0.5rem;
		font: inherit;
		font-weight: 600;
	}
</style>
