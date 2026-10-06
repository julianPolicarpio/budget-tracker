<script lang="ts">
	/**
	 * One catalogue action, rendered *inside* the logging surface.
	 *
	 * Tapping an action-feature pill used to close the typing bar and open the
	 * Actions panel, so the two screens read as a jump between two UIs (owner
	 * request: "make the other action tabs have the same UI as the logging so
	 * that the transition is seamless"). This is what the bar shows instead:
	 * the same `.panel` chrome — `LogOverlay` owns that — with the action's
	 * own form swapped in where the entry field was.
	 *
	 * Chrome-less on purpose: no fixed positioning, no panel box, no close
	 * button of its own, so the host supplies the surface and the change is a
	 * content swap rather than a screen change. The hint row is repeated here
	 * because Esc still closes the whole surface — same key, same copy, both
	 * states.
	 */
	import { actionViewFor, placeholderTarget } from '$lib/actions/action-view';
	import type { ActionContext } from '$lib/actions/context';
	import type { ActionDraft } from '$lib/actions/draft';
	import RecordIncomeForm from './RecordIncomeForm.svelte';
	import RecordRefundForm from './RecordRefundForm.svelte';
	import TransferMoneyForm from './TransferMoneyForm.svelte';
	import FundPlannedExpenseForm from './FundPlannedExpenseForm.svelte';
	import MoveBetweenPurposesForm from './MoveBetweenPurposesForm.svelte';
	import AddTripForm from './AddTripForm.svelte';
	import CreatePlannedExpenseForm from './CreatePlannedExpenseForm.svelte';
	import AddBillSubscriptionForm from './AddBillSubscriptionForm.svelte';
	import AddDebtForm from './AddDebtForm.svelte';
	import SaveForLaterForm from './SaveForLaterForm.svelte';
	import AddAccountForm from './AddAccountForm.svelte';
	import AddEditRuleForm from './AddEditRuleForm.svelte';

	interface Props {
		actionId: string;
		context: ActionContext;
		/** Back to the typing bar — the host owns that state. */
		onBack: () => void;
		/** The action's own form recorded something: the host closes the surface. */
		onSaved: () => void;
		draft?: ActionDraft;
		onDraftChange?: (draft: ActionDraft) => void;
	}

	let { actionId, context, onBack, onSaved, draft, onDraftChange }: Props = $props();

	const view = $derived(actionViewFor(actionId));
	const placeholder = $derived(
		view && view.kind !== 'form' ? placeholderTarget(view.action) : null
	);

	let backEl = $state<HTMLButtonElement | undefined>();
	let bodyEl = $state<HTMLDivElement | undefined>();

	/**
	 * Land in the first field, not on the chrome: the bar exists so the
	 * keyboard is already where the work is, and an action form is the same
	 * promise one step further in. A view with no field (a placeholder) falls
	 * back to Back, so focus is never left on the entry input hidden behind
	 * this.
	 */
	$effect(() => {
		if (!view) return;
		queueMicrotask(() => {
			const fields = bodyEl?.querySelectorAll<HTMLElement>('input, select, textarea');
			// Skip the forms' hidden plumbing (`clientUuid` and friends):
			// focusing one is a silent no-op, so a naive `input` selector
			// would leave the keyboard nowhere at all.
			const field = fields
				? Array.from(fields).find(
						(el) =>
							(el as HTMLInputElement).type !== 'hidden' &&
							!el.hasAttribute('disabled') &&
							el.getClientRects().length > 0
					)
				: undefined;
			(field ?? backEl)?.focus();
		});
	});
</script>

{#if view}
	<div class="action-view">
		<div class="head">
			<button type="button" class="back" bind:this={backEl} onclick={onBack}>← Back</button>
			<h2 class="label">{view.action.label}</h2>
		</div>

		<div class="body" bind:this={bodyEl}>
			{#if draft?.sourceText}
				<p class="source">From “{draft.sourceText}”</p>
			{/if}
			{#if view.kind === 'form'}
				{#if view.formId === 'record-income'}
					<RecordIncomeForm accounts={context.accounts} {onSaved} />
				{:else if view.formId === 'record-refund'}
					<RecordRefundForm refundable={context.refundable} accounts={context.accounts} {onSaved} />
				{:else if view.formId === 'transfer-money'}
					<TransferMoneyForm accounts={context.accounts} {onSaved} />
				{:else if view.formId === 'fund-planned-expense'}
					<FundPlannedExpenseForm plannedExpenses={context.plannedExpenses} accounts={context.accounts} {onSaved} />
				{:else if view.formId === 'move-between-purposes'}
					<MoveBetweenPurposesForm accounts={context.accounts} {onSaved} />
				{:else if view.formId === 'add-trip'}
					<AddTripForm {onSaved} />
				{:else if view.formId === 'create-planned-expense'}
					<CreatePlannedExpenseForm {onSaved} />
				{:else if view.formId === 'add-bill-subscription'}
					<AddBillSubscriptionForm {onSaved} {draft} {onDraftChange} />
				{:else if view.formId === 'add-debt'}
					<AddDebtForm {onSaved} />
				{:else if view.formId === 'save-for-later'}
					<SaveForLaterForm {onSaved} />
				{:else if view.formId === 'add-account'}
					<AddAccountForm {onSaved} />
				{:else if view.formId === 'add-edit-rule'}
					<AddEditRuleForm {onSaved} />
				{/if}
			{:else if placeholder}
				<p class="placeholder">
					Not a quick form yet — use the <a href={placeholder.href}>{placeholder.label}</a> tab to
					{view.action.label.toLowerCase()}.
				</p>
			{/if}
		</div>

		<p class="hint"><span><kbd>Esc</kbd> cancel</span></p>
	</div>
{/if}

<style>
	/* Same tokens and rhythm as `LogOverlay.svelte`'s panel — the two states
	   have to read as one surface, so nothing here invents a type scale:
	   `.head` borrows the amount row's hairline, `.hint` is the overlay's hint
	   bar verbatim, and `kbd` is its key cap. */
	.action-view {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 0.625rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--hairline);
	}

	.back {
		font: inherit;
		font-size: 0.8125rem;
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink-muted);
		cursor: pointer;
	}

	.back:hover,
	.back:focus-visible {
		color: var(--ink);
	}

	/* The action's name, in the app's label voice — the same quiet, spaced
	   small caps the rest of the app uses for what a thing *is*. */
	.label {
		flex: 1 1 auto;
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.placeholder {
		margin: 0;
		font-size: 0.875rem;
		color: var(--ink-secondary);
	}

	.source {
		margin: 0 0 0.75rem;
		font-size: 0.75rem;
		color: var(--ink-muted);
		overflow-wrap: anywhere;
	}

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
</style>
