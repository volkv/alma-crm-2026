<script lang="ts">
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import XIcon from '@lucide/svelte/icons/x';
	import { untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { formatBytes, pluralize } from '$lib/format';

	/**
	 * Выбор файлов перетаскиванием или диалогом.
	 *
	 * Пропсы те же, что у `FileInput`, и в форму уходит тот же нативный
	 * `<input type="file">`: перетащенные файлы кладутся прямо в него, поэтому
	 * форма отправляет их обычным образом, `required` проверяет браузер, а
	 * замена одного контрола другим не трогает обработчик формы. Инпут спрятан с
	 * экрана, но не выключен — фокус с клавиатуры и Enter/Space открывают диалог
	 * без единой строки скрипта, а зона целиком — подпись к нему.
	 */
	let {
		id,
		name = id,
		label,
		description,
		accept,
		multiple = false,
		required = false,
		onchoose
	}: {
		/** Идентификатор контрола; он же имя поля формы, если имя не задано. */
		id: string;
		name?: string;
		label: string;
		/** Что за файл ждут: форматы, размер, назначение. */
		description?: string;
		/** Отбор в диалоге и при перетаскивании: `.pdf,.docx` или `application/pdf`. */
		accept?: string;
		/** Несколько файлов за раз: повторный выбор добавляет к уже выбранным. */
		multiple?: boolean;
		required?: boolean;
		/**
		 * Что выбрано: имена файлов после каждого изменения — выбора, перетаскивания,
		 * снятия файла и сброса формы.
		 */
		onchoose?: (names: readonly string[]) => void;
	} = $props();

	let input = $state<HTMLInputElement>();
	let chosen = $state<File[]>([]);
	let dragging = $state(false);

	/**
	 * Итог последнего выбора для чтения с экрана. Отказ виден всем — файл молча
	 * пропал бы из выбора, — а удачное добавление и так видно по списку, поэтому
	 * его слышно, но не видно.
	 */
	let notice = $state<{ text: string; problem: boolean } | null>(null);

	/**
	 * `dragenter` и `dragleave` приходят на каждый дочерний элемент зоны, и при
	 * переходе с текста на иконку подсветка мигала бы. Считаем входы и выходы:
	 * зона погасает, только когда курсор покинул её целиком.
	 */
	let depth = 0;

	const rules = $derived(
		(accept ?? '')
			.split(',')
			.map((rule) => rule.trim().toLowerCase())
			.filter((rule) => rule !== '')
	);

	/**
	 * Та же проверка, что делает диалог выбора: расширение, точный тип или
	 * семейство типов (`image/*`). Браузер `accept` при отправке не проверяет, а
	 * перетаскивание его и вовсе обходит, поэтому отбор здесь — чтобы чужой файл
	 * не доехал до сервера и не вернулся отказом всей загрузки.
	 */
	function fits(file: File): boolean {
		if (rules.length === 0) {
			return true;
		}

		const fileName = file.name.toLowerCase();
		const type = file.type.toLowerCase();

		return rules.some((rule) =>
			rule.startsWith('.')
				? fileName.endsWith(rule)
				: rule.endsWith('/*')
					? type.startsWith(rule.slice(0, -1))
					: type === rule
		);
	}

	function sameFile(a: File, b: File): boolean {
		return a.name === b.name && a.size === b.size;
	}

	/**
	 * Выбор держит сам инпут: `FileList` не собрать и не поправить напрямую,
	 * поэтому после любого изменения он пересобирается через `DataTransfer`.
	 */
	function commit(files: File[]) {
		if (input) {
			const transfer = new DataTransfer();

			for (const file of files) {
				transfer.items.add(file);
			}

			input.files = transfer.files;
		}

		chosen = files;
		onchoose?.(files.map((file) => file.name));
	}

	/** Новые файлы к выбору: без `multiple` первый подходящий заменяет прежний. */
	function add(incoming: File[]) {
		const fitting = incoming.filter(fits);
		const rejected = incoming.filter((file) => !fits(file));

		let next: File[];
		let taken: File[];

		if (multiple) {
			taken = fitting.filter(
				(file, index) =>
					!chosen.some((existing) => sameFile(existing, file)) &&
					fitting.findIndex((other) => sameFile(other, file)) === index
			);
			next = [...chosen, ...taken];
		} else {
			taken = fitting.slice(0, 1);
			next = taken.length > 0 ? taken : chosen;
		}

		commit(next);

		if (rejected.length > 0) {
			notice = {
				text: `Не подходит по формату: ${rejected.map((file) => file.name).join(', ')}`,
				problem: true
			};
		} else if (!multiple && fitting.length > 1) {
			notice = { text: `Можно выбрать один файл — взят «${taken[0].name}»`, problem: true };
		} else if (taken.length > 0) {
			notice = {
				text: `Добавлено: ${pluralize(taken.length, ['файл', 'файла', 'файлов'])}`,
				problem: false
			};
		} else {
			notice = null;
		}
	}

	/**
	 * Диалог выбора заменяет содержимое инпута целиком, поэтому прежний выбор
	 * берётся из состояния и новые файлы добавляются к нему, как при
	 * перетаскивании. Отмена диалога в части браузеров очищает инпут — тогда
	 * выбор просто восстанавливается.
	 */
	function pick(event: Event & { currentTarget: HTMLInputElement }) {
		const picked = Array.from(event.currentTarget.files ?? []);

		if (!multiple && picked.length === 0) {
			commit([]);
			notice = null;

			return;
		}

		add(picked);
	}

	function remove(file: File) {
		commit(chosen.filter((existing) => existing !== file));
		notice = null;
		// Кнопка исчезает вместе со строкой; фокус возвращается в зону, а не
		// теряется в начале страницы.
		input?.focus();
	}

	function carriesFiles(event: DragEvent): boolean {
		return event.dataTransfer?.types.includes('Files') ?? false;
	}

	function dragenter(event: DragEvent) {
		if (!carriesFiles(event)) {
			return;
		}

		event.preventDefault();
		depth += 1;
		dragging = true;
	}

	function dragover(event: DragEvent) {
		if (!carriesFiles(event)) {
			return;
		}

		// Без отмены `dragover` браузер не даст бросить файл, а открыл бы его
		// вместо страницы.
		event.preventDefault();

		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}
	}

	function dragleave(event: DragEvent) {
		if (!carriesFiles(event)) {
			return;
		}

		depth = Math.max(0, depth - 1);
		dragging = depth > 0;
	}

	function drop(event: DragEvent) {
		if (!carriesFiles(event)) {
			return;
		}

		event.preventDefault();
		depth = 0;
		dragging = false;
		add(Array.from(event.dataTransfer?.files ?? []));
	}

	/**
	 * `form.reset()` после удачной отправки очищает инпут, но не список под
	 * зоной, — список следует за ним. Файл, выбранный до гидратации, подхватывается
	 * здесь же: до неё список не рисовался.
	 */
	$effect(() => {
		const form = input?.form;

		untrack(() => {
			if (input?.files && input.files.length > 0 && chosen.length === 0) {
				chosen = Array.from(input.files);
			}
		});

		if (!form) {
			return;
		}

		const clear = () => {
			chosen = [];
			notice = null;
			onchoose?.([]);
		};

		form.addEventListener('reset', clear);

		return () => form.removeEventListener('reset', clear);
	});
</script>

<div class="flex flex-col gap-1.5" data-slot="file-dropzone">
	<Label id="{id}-label" for={id}>
		{label}
		{#if required}
			<span class="text-danger" aria-hidden="true">*</span>
			<span class="sr-only">обязательное поле</span>
		{/if}
	</Label>

	<!-- Перетаскивание — улучшение для мыши: тот же выбор доступен с клавиатуры
		через инпут внутри зоны, поэтому у самой зоны нет роли и фокуса. -->
	<div
		role="presentation"
		class="relative rounded-lg border border-dashed border-input bg-muted/40 transition-colors hover:bg-muted has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring has-[input:focus-visible]:outline-solid data-dragging:border-solid data-dragging:border-ring data-dragging:bg-selection"
		data-dragging={dragging ? '' : undefined}
		ondragenter={dragenter}
		ondragover={dragover}
		ondragleave={dragleave}
		ondrop={drop}
	>
		<input
			bind:this={input}
			{id}
			{name}
			{accept}
			{multiple}
			{required}
			type="file"
			class="sr-only"
			aria-labelledby="{id}-label"
			aria-describedby={description ? `${id}-description` : undefined}
			onchange={pick}
		/>
		<!-- Зона целиком — подпись к инпуту: щелчок в любом месте открывает диалог
			и до гидратации. -->
		<label
			for={id}
			class="flex cursor-pointer flex-col items-center gap-1 px-4 py-6 text-center select-none"
		>
			<FileUpIcon
				class="mb-1 size-6 {dragging ? 'text-selection-foreground' : 'text-muted-foreground'}"
				aria-hidden="true"
			/>
			<span class="text-sm font-medium">
				Перетащите {multiple ? 'файлы' : 'файл'} сюда или
				<span class="text-link underline underline-offset-2">выберите на компьютере</span>
			</span>
			{#if description}
				<span id="{id}-description" class="text-xs text-muted-foreground">{description}</span>
			{/if}
		</label>
		<p
			aria-live="polite"
			class={notice?.problem
				? 'px-4 pb-3 text-center text-xs text-danger-soft-foreground'
				: 'sr-only'}
		>
			{notice?.text ?? ''}
		</p>
	</div>

	{#if chosen.length > 0}
		<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
			{#each chosen as file (`${file.name}:${file.size}`)}
				<li class="flex items-center gap-2 py-1 pr-1 pl-3 text-sm">
					<span class="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
					<span class="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
					<Button
						variant="ghost"
						size="icon-xs"
						class="text-muted-foreground hover:text-foreground"
						aria-label="Убрать «{file.name}»"
						onclick={() => remove(file)}
					>
						<XIcon aria-hidden="true" />
					</Button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
