<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>LCT CRM</title>
</svelte:head>

<div class="min-h-screen bg-white font-sans text-slate-900">
	{@render children()}
</div>
