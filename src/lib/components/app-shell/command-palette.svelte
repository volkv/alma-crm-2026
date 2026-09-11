<script lang="ts">
	import * as Command from '$lib/components/ui/command/index.js';

	/**
	 * The single entry point for finding anything: `Ctrl`/`⌘` + `K` anywhere in
	 * the app. It is deliberately empty until the sections that own the data
	 * exist — the shortcut, the dialog and the place results will appear in are
	 * already here, so adding a source later is adding a `Command.Group`.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Command.Dialog
	bind:open
	title="Поиск"
	description="Поиск по организациям, контактам и документам"
	loop
>
	<Command.Input placeholder="Что ищем?" />
	<Command.List>
		<Command.Empty>Поиск заработает вместе с разделами.</Command.Empty>
	</Command.List>
</Command.Dialog>
