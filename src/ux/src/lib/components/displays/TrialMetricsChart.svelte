<!-- Copyright IBM Corp. 2024-2026 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

<script lang="ts">
	import { LineChart } from '@carbon/charts-svelte';
	import {
		ContentSwitcher,
		Switch,
		Slider,
		Toggle,
		InlineLoading,
		InlineNotification
	} from 'carbon-components-svelte';
	import { onMount } from 'svelte';
	import { API } from '$lib/api';
	import type { MetricPoint, Status } from '$lib/app-types';
	import {
		buildLossPanel,
		buildLrPanel,
		buildGradPanel,
		epochBoundaries,
		median,
		hasUsableMetrics,
		type XField
	} from '$lib/metrics-shaping';

	export let jobId: string;
	export let trialId: string;
	export let status: Status;

	const api = new API();

	// A trial with no run yet cannot have metrics — empty state, no request. 'PAUSED' isn't in
	// the Status union (a pre-existing gap; see api-mappers.ts) so cast rather than widen it.
	const CAN_HAVE_METRICS: Status[] = [
		'RUNNING',
		'PAUSED' as Status,
		'COMPLETED',
		'ERROR',
		'TERMINATED'
	];

	let points: MetricPoint[] = [];
	let loading = true;
	let errored = false;

	let xIndex = 0; // 0 = global_step (default), 1 = epoch
	let weight = 0.7; // EMA smoothing weight
	let showRaw = true;

	$: xField = (xIndex === 0 ? 'global_step' : 'epoch') as XField;
	$: usable = hasUsableMetrics(points);

	$: lossData = buildLossPanel(points, xField, weight, showRaw);
	$: lrData = buildLrPanel(points, xField);
	$: gradData = buildGradPanel(points, xField);
	$: epochs = epochBoundaries(points, xField);
	$: gradMedian = median(gradData.map((d) => d.value));
	$: xMax = Math.max(
		0,
		...lossData.map((d) => d.key),
		...lrData.map((d) => d.key),
		...gradData.map((d) => d.key)
	);

	// The app persists the Carbon theme on <html theme="…"> (default g10); those names are also
	// @carbon/charts' theme names (theme?: ChartTheme | string), so pass the string straight through.
	const chartTheme = (): string =>
		(typeof document !== 'undefined' && document.documentElement.getAttribute('theme')) || 'g10';
	const expFmt = (tick: number | Date): string => Number(tick).toExponential(1);

	// The three panels' left-axis gutters are auto-sized by @carbon/charts from their widest tick
	// label, so differing label widths (loss "15" vs LR "4.0e-6" vs grad "4") push the plots out of
	// vertical alignment. Fix: give every axis a fixed-shape "NN.N" label. U+2007 (figure space)
	// renders at digit width — even in a proportional font — so padding the integer part to two
	// places makes all labels the same rendered width, hence the same gutter, hence aligned plots.
	const FIG = ' ';
	const padInt = (s: string, intWidth: number): string => {
		const intLen = (s.startsWith('-') ? s.slice(1) : s).split('.')[0].length;
		return FIG.repeat(Math.max(0, intWidth - intLen)) + s;
	};
	const fmtY = (tick: number | Date): string => padInt(Number(tick).toFixed(1), 2);
	// learning_rate is ~1e-7; label the axis in ×10⁻⁶ units so its ticks are short like the others
	// (real values still show in the tooltip via expFmt).
	const fmtLr = (tick: number | Date): string => padInt((Number(tick) * 1e6).toFixed(1), 2);
	// Show just the epoch/median label on a threshold callout, not the raw axis value ("E2: 45.333").
	const noValue = (): string => '';

	// Shared bottom axis: same [0, xMax] domain on every panel so they line up, with vertical
	// epoch threshold lines. Only the bottom-most (grad) panel carries the axis title.
	$: bottomAxis = (withTitle: boolean) => ({
		title: withTitle ? (xField === 'global_step' ? 'Step' : 'Epoch') : undefined,
		mapsTo: 'key',
		domain: [0, xMax],
		thresholds: epochs.map((e) => ({ value: e.value, label: e.label, valueFormatter: noValue }))
	});

	$: lossOptions = {
		theme: chartTheme(),
		title: 'Loss',
		axes: {
			bottom: bottomAxis(false),
			left: { title: 'Loss', mapsTo: 'value', ticks: { formatter: fmtY } }
		},
		curve: 'curveMonotoneX',
		legend: { enabled: true },
		points: { enabled: true, radius: 3 },
		toolbar: { numberOfIcons: 2 }
	};
	$: lrOptions = {
		theme: chartTheme(),
		title: 'Learning rate',
		axes: {
			bottom: bottomAxis(false),
			left: { title: 'LR (×10⁻⁶)', mapsTo: 'value', ticks: { formatter: fmtLr } }
		},
		curve: 'curveMonotoneX',
		legend: { enabled: false },
		points: { enabled: true, radius: 3 },
		toolbar: { enabled: false },
		tooltip: { valueFormatter: expFmt }
	};
	$: gradOptions = {
		theme: chartTheme(),
		title: 'Gradient norm',
		axes: {
			bottom: bottomAxis(true),
			left: {
				title: 'Grad norm',
				mapsTo: 'value',
				includeZero: true,
				ticks: { formatter: fmtY },
				thresholds:
					gradMedian == null
						? []
						: [{ value: gradMedian, label: 'median', valueFormatter: noValue }]
			}
		},
		curve: 'curveMonotoneX',
		legend: { enabled: false },
		points: { enabled: true, radius: 3 },
		toolbar: { enabled: false }
	};

	onMount(async () => {
		if (!CAN_HAVE_METRICS.includes(status)) {
			loading = false;
			return;
		}
		try {
			points = await api.getTrialMetrics(jobId, trialId);
		} catch (e) {
			errored = true;
			console.error('Failed to load trial metrics', e);
		} finally {
			loading = false;
		}
	});
</script>

{#if loading}
	<InlineLoading description="Loading metrics…" />
{:else if errored}
	<InlineNotification
		kind="error"
		lowContrast
		hideCloseButton
		title="Couldn't load metrics"
		subtitle="Try reopening this tab."
	/>
{:else if !usable}
	<InlineNotification
		kind="info"
		lowContrast
		hideCloseButton
		title="No metrics yet"
		subtitle="This trial hasn't reported training metrics yet."
	/>
{:else}
	<div class="metrics-controls">
		<ContentSwitcher size="sm" bind:selectedIndex={xIndex}>
			<Switch text="Step" />
			<Switch text="Epoch" />
		</ContentSwitcher>
		<div class="sm-slider">
			<Slider
				labelText="Smoothing"
				min={0}
				max={0.95}
				step={0.05}
				bind:value={weight}
				hideTextInput
			/>
		</div>
		<Toggle size="sm" labelText="Raw train loss" labelA="Off" labelB="On" bind:toggled={showRaw} />
	</div>
	<div class="panel panel-loss"><LineChart data={lossData} options={lossOptions} /></div>
	<div class="panel panel-sm"><LineChart data={lrData} options={lrOptions} /></div>
	<div class="panel panel-sm"><LineChart data={gradData} options={gradOptions} /></div>
{/if}

<style>
	.metrics-controls {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}
	.sm-slider {
		min-width: 220px;
	}
	.panel {
		margin-bottom: 0.75rem;
	}
	.panel-loss {
		height: 280px;
	}
	.panel-sm {
		height: 170px;
	}
</style>
