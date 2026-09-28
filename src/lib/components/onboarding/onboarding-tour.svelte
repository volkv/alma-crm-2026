<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Pathname } from '$app/types';
	import ListIcon from '@lucide/svelte/icons/list';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Progress } from '$lib/components/ui/progress/index.js';
	import { pluralize } from '$lib/format';
	import { matchesQuery, screenForPath, withQuery } from '$lib/onboarding/screens';
	import { tourMinutes, type TourStop, type TourStopScreen } from '$lib/onboarding/tours';
	import type { OnboardingTour } from '$lib/onboarding/tour.svelte';

	/**
	 * Подсказки: рамка вокруг элемента, о котором идёт речь, и карточка с
	 * остановкой рядом с ней.
	 *
	 * Компонент стоит в оболочке приложения, а не на странице: тур переживает
	 * переход между экранами — и сам же его делает. Остановка, чей элемент живёт
	 * в другом разделе, уводит туда без единого нажатия: человек, которому
	 * показывают систему, не должен вести экскурсию сам.
	 *
	 * Рамка рисуется поверх страницы своим слоем и ничего не двигает: подсветка,
	 * меняющая раскладку, показывала бы человеку не тот экран, которым он потом
	 * будет пользоваться. Координаты пересчитываются покадрово, пока тур открыт, —
	 * страница под ним прокручивается плавно, а липкая шапка и вкладки двигают
	 * элементы и без прокрутки.
	 */
	let { tour }: { tour: OnboardingTour } = $props();

	type Box = { top: number; left: number; width: number; height: number };

	/** Отступ рамки от элемента и карточки от рамки. */
	const PADDING = 4;
	const GAP = 12;
	/** Поля экрана: ближе к краю карточку не ставим. */
	const EDGE = 16;
	/** Уже этого карточка встаёт понизу экрана: рядом с элементом ей уже не поместиться. */
	const NARROW = 640;

	const TITLE_ID = 'onboarding-tour-title';

	let card = $state<HTMLElement | null>(null);
	let frame = $state<Box | null>(null);
	/** Куда встала карточка; `null` — прижата к низу экрана. */
	let anchor = $state<{ top: number; left: number } | null>(null);
	/** Есть ли элемент остановки на этом экране. */
	let found = $state(false);
	/** Открыто ли оглавление: пока да, Esc принадлежит ему, а не туру. */
	let chaptersOpen = $state(false);
	/** Название экрана, на который тур сейчас переходит; `null` — никуда. */
	let navigating = $state<string | null>(null);
	/**
	 * Для какой остановки и экрана элемент уже показали: второй раз не
	 * прокручиваем и не забираем фокус. Обычная переменная, а не руна: её читает
	 * только эффект, который сам же её и пишет, — реактивная отметка
	 * перезапускала бы его и отменяла бы то, что он только что назначил.
	 */
	let shownFor = '';
	/**
	 * Остановка, ради которой переход уже делали. Второго `goto` не будет: если
	 * человек ушёл с экрана сам, тур предложит вернуться кнопкой, а не утащит
	 * его обратно силой — иначе уйти из тура было бы нельзя.
	 */
	let navigatedFor = '';

	const stop = $derived(tour.stop);
	const total = $derived(tour.stops.length);
	const stopKey = $derived(`${stop?.id ?? ''}@${page.url.pathname}`);
	const isLast = $derived(tour.index === total - 1);
	/** Карточка по центру и без рамки: приветствие и финал не о конкретном блоке. */
	const centered = $derived(stop !== null && stop.target === null);
	/** Открыт ли экран остановки — без оглядки на параметры адреса. */
	const onScreenPath = $derived(
		stop === null || stop.screen === null
			? true
			: screenForPath(page.url.pathname)?.id === stop.screen.id
	);
	/**
	 * Стоит ли человек там, где остановку показывают: на её экране и в её
	 * режиме — доска или таблица, включённый фильтр (`TourStep.query`).
	 */
	const onScreen = $derived(onScreenPath && matchesQuery(page.url, stop?.query ?? null));

	/**
	 * Куда вести ради остановки. Уже на её экране меняются только параметры
	 * шага — отбор, который человек выставил сам, остаётся; с другого экрана —
	 * адрес экрана с параметрами шага.
	 */
	function stopHref(current: TourStop, screen: TourStopScreen): string {
		return onScreenPath
			? withQuery(page.url.pathname, page.url.search, current.query)
			: withQuery(screen.href, '', current.query);
	}

	function goToStop(current: TourStop, screen: TourStopScreen): void {
		navigating = screen.title;
		// Реестр хранит обычные пути приложения, и идентификатор записи в них уже
		// подставлен, поэтому `resolve()` только добавляет базовый путь.
		// Приведение — то же, что в навигации оболочки: разбирать объединение всех
		// маршрутов ради одной ветви незачем. Смена режима на том же экране не
		// копит историю и не прокручивает страницу к началу.
		void goto(resolve(stopHref(current, screen) as Pathname & '/'), {
			replaceState: onScreenPath,
			noScroll: onScreenPath,
			keepFocus: true
		});
	}

	function element(): HTMLElement | null {
		const target = tour.stop?.target ?? null;

		if (target === null) {
			return null;
		}

		// Одна метка стоит в двух местах сразу: поиск, справку и тему держат и
		// меню разделов, и нижняя панель телефона, а видно всегда одно из двух.
		// Поэтому первый показанный узел, а не первый в разметке: рамка обязана
		// встать вокруг того, что на экране.
		for (const node of document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
			if (node.getClientRects().length > 0) {
				return node;
			}
		}

		return null;
	}

	/** Просил ли человек систему не двигать: настройка устройства, а не наша. */
	function reducedMotion(): boolean {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	/** Ссылки и кнопки карточки в порядке разметки: и ловушке Tab, и начальному фокусу нужен один и тот же список. */
	function focusables(): HTMLElement[] {
		if (card === null) {
			return [];
		}

		return [...card.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
	}

	function sameBox(left: Box | null, right: Box | null): boolean {
		if (left === null || right === null) {
			return left === right;
		}

		return (
			left.top === right.top &&
			left.left === right.left &&
			left.width === right.width &&
			left.height === right.height
		);
	}

	/** Карточка рядом с элементом: под ним, а если внизу не помещается — над. */
	function place(target: DOMRect | null): void {
		if (card === null) {
			return;
		}

		if (target === null || window.innerWidth < NARROW) {
			if (anchor !== null) {
				anchor = null;
			}

			return;
		}

		const size = card.getBoundingClientRect();
		const below = target.bottom + GAP + PADDING;
		const above = target.top - PADDING - GAP - size.height;
		const bottomLimit = Math.max(window.innerHeight - size.height - EDGE, EDGE);
		const top = Math.min(
			Math.max(below + size.height > window.innerHeight - EDGE ? above : below, EDGE),
			bottomLimit
		);
		const left = Math.min(
			Math.max(target.left, EDGE),
			Math.max(window.innerWidth - size.width - EDGE, EDGE)
		);

		if (anchor === null || anchor.top !== top || anchor.left !== left) {
			anchor = { top, left };
		}
	}

	/** Один пересчёт рамки и карточки по текущему положению элемента. */
	function sync(): void {
		const target = element();

		if (found !== (target !== null)) {
			found = target !== null;
		}

		if (target === null) {
			if (frame !== null) {
				frame = null;
			}

			place(null);

			return;
		}

		const rect = target.getBoundingClientRect();
		const next = {
			top: rect.top - PADDING,
			left: rect.left - PADDING,
			width: rect.width + PADDING * 2,
			height: rect.height + PADDING * 2
		};

		if (!sameBox(frame, next)) {
			frame = next;
		}

		place(rect);
	}

	/** Вернуться на экран остановки после того, как человек ушёл с него сам. */
	function returnToStep(): void {
		const current = tour.stop;

		if (current === null || current.screen === null) {
			return;
		}

		goToStop(current, current.screen);
	}

	// Первый вход: признаки «показано» лежат в браузере, и прочитать их можно
	// только здесь — на сервере тура нет.
	$effect(() => {
		tour.syncSeen();
		tour.autoStart();
	});

	$effect(() => {
		if (!tour.open || centered) {
			return;
		}

		let handle = requestAnimationFrame(function tick() {
			sync();
			handle = requestAnimationFrame(tick);
		});

		return () => cancelAnimationFrame(handle);
	});

	// Тур ведёт сам: остановка, чей экран сейчас не открыт, открывает его.
	$effect(() => {
		if (!tour.open) {
			navigatedFor = '';
			navigating = null;

			return;
		}

		const current = tour.stop;

		if (current === null || current.screen === null || onScreen) {
			navigating = null;

			return;
		}

		if (navigatedFor === current.id) {
			// Переход для этой остановки уже был — значит, с экрана ушли сами.
			navigating = null;

			return;
		}

		navigatedFor = current.id;
		goToStop(current, current.screen);
	});

	$effect(() => {
		const key = stopKey;

		if (!tour.open) {
			if (shownFor !== '') {
				shownFor = '';
			}

			return;
		}

		if (key === shownFor) {
			return;
		}

		shownFor = key;

		// Кадром позже: после перехода между экранами разметка новой страницы к
		// этому моменту ещё не смонтирована, и искать в ней нечего.
		//
		// Плавность — только тем, кто её не просил отключать: карточка ходит за
		// элементом покадрово, и пока страница едет, она едет вместе с ней. Кому
		// движение мешает, тому шаг встаёт сразу.
		const handle = requestAnimationFrame(() => {
			element()?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });

			// Фокус уходит на первую кнопку карточки, а не на саму карточку: контур
			// вокруг всего диалога после программного фокуса читался как лишняя
			// толстая рамка, а кнопка носит свой обычный контур фокуса. Карточка —
			// запасной получатель на случай, если в ней вдруг нет ни одной кнопки.
			(focusables()[0] ?? card)?.focus();
		});

		return () => cancelAnimationFrame(handle);
	});

	function onWindowKeydown(event: KeyboardEvent): void {
		// Esc убирает подсказки: они не должны стоять между человеком и работой,
		// за которой он пришёл. Открытое оглавление забирает Esc себе — иначе
		// закрытие списка экранов уносило бы с собой весь тур.
		if (tour.open && !chaptersOpen && event.key === 'Escape') {
			event.preventDefault();
			tour.close();
		}
	}

	function onCardKeydown(event: KeyboardEvent): void {
		if (chaptersOpen) {
			return;
		}

		if (event.key === 'ArrowRight') {
			event.preventDefault();
			tour.next();

			return;
		}

		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			tour.back();

			return;
		}

		if (event.key !== 'Tab' || card === null) {
			return;
		}

		// Ловушка фокуса: страница под туром выключена слоем, и уводить в неё Tab
		// значило бы отправлять клавиатуру туда, где ничего не нажимается.
		const stops = focusables();
		const first = stops[0];
		const last = stops[stops.length - 1];

		if (first === undefined || last === undefined) {
			return;
		}

		if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if tour.open && stop !== null}
	<!-- Слой ловит нажатия мимо карточки: пока идут подсказки, шаг один, и
		случайный клик по странице не уводил бы человека из тура молча. Затемнение
		такое же лёгкое, как у диалогов (`ui/dialog`): рамка и так показывает, о
		чём речь. -->
	<div class="fixed inset-0 z-50 bg-black/10" aria-hidden="true"></div>

	{#if frame !== null && !centered}
		<div
			class="pointer-events-none fixed z-50 rounded-lg ring-2 ring-link ring-offset-2 ring-offset-canvas"
			data-testid="onboarding-frame"
			style="top: {frame.top}px; left: {frame.left}px; width: {frame.width}px; height: {frame.height}px"
			aria-hidden="true"
		></div>
	{/if}

	<div
		bind:this={card}
		role="dialog"
		aria-modal="true"
		aria-labelledby={TITLE_ID}
		tabindex="-1"
		data-testid="onboarding-tour"
		onkeydown={onCardKeydown}
		class="fixed z-50 flex w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-lg focus-ring {centered
			? 'top-1/2 left-1/2 max-w-md -translate-x-1/2 -translate-y-1/2'
			: 'max-w-sm'} {!centered && anchor === null ? 'bottom-4 left-1/2 -translate-x-1/2' : ''}"
		style={centered || anchor === null ? undefined : `top: ${anchor.top}px; left: ${anchor.left}px`}
	>
		{#if stop.kind === 'welcome'}
			<h2 id={TITLE_ID} class="text-base font-semibold">{stop.title}</h2>
			<p class="text-sm text-muted-foreground">{stop.body}</p>

			{#if stop.map !== null}
				<p class="mt-1 text-xs font-medium">Тур пройдёт по экранам вашей роли:</p>
				<ul class="max-h-48 list-inside list-disc overflow-y-auto text-xs text-muted-foreground">
					{#each stop.map as title (title)}
						<li>{title}</li>
					{/each}
				</ul>
			{/if}

			<p class="text-xs text-faint">
				{pluralize(total, ['шаг', 'шага', 'шагов'])} · примерно {pluralize(tourMinutes(total), [
					'минута',
					'минуты',
					'минут'
				])}
			</p>

			{#if tour.samplesFailed}
				<p class="text-xs text-warning-soft-foreground">
					Список записей не ответил — экраны с открытой карточкой в этот тур не попали.
				</p>
			{/if}

			<div class="mt-2 flex items-center justify-between gap-2">
				<Button variant="ghost" size="sm" onclick={() => tour.close()}>Позже</Button>
				<Button size="sm" onclick={() => tour.next()}>Начать тур</Button>
			</div>
		{:else}
			<div class="flex items-center justify-between gap-2">
				<p class="min-w-0 truncate text-xs text-muted-foreground">
					{#if stop.screen !== null}
						{stop.screen.title} · шаг {stop.screen.position} из {stop.screen.total}
					{:else if stop.kind === 'shell'}
						Оболочка системы
					{/if}
				</p>
				{#if tour.chapters.length > 0}
					<DropdownMenu.Root bind:open={chaptersOpen}>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="ghost" size="sm" class="shrink-0 gap-1.5 text-xs">
									<ListIcon aria-hidden="true" />
									Оглавление
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="max-h-72 w-56 overflow-y-auto">
							<!-- Общий счёт по всему туру («шаг 7 из 64») стоит только здесь: строкой в
								самой карточке он спорил со счётом по экрану через строку ниже — оба
								назывались «шаг N из M» про разные вещи. -->
							<DropdownMenu.Label>
								Экраны тура · шаг {tour.index + 1} из {total}
							</DropdownMenu.Label>
							{#each tour.chapters as chapter (chapter.screenId)}
								<DropdownMenu.Item onSelect={() => tour.goToScreen(chapter.screenId)}>
									{chapter.title}
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
			</div>

			<Progress value={tour.index + 1} max={total} aria-label="Прогресс по туру" />

			<h2 id={TITLE_ID} class="text-sm font-semibold">{stop.title}</h2>
			<p class="text-sm text-muted-foreground">{stop.body}</p>

			{#if navigating !== null}
				<p class="text-xs text-muted-foreground">Открываем «{navigating}»…</p>
			{:else if !onScreen && stop.screen !== null}
				<Button variant="outline" size="sm" class="self-start" onclick={returnToStep}>
					Вернуться к шагу
				</Button>
			{:else if !found && stop.target !== null}
				<!-- Признак «блок не найден» нужен проверкам: по нему прогон отличает шаг,
					нашедший элемент, от шага, который показал подсказку вместо рамки. -->
				<p class="text-xs text-warning-soft-foreground" data-testid="onboarding-missing">
					{stop.hint ?? 'На этом экране блока сейчас нет — шаг можно пропустить.'}
				</p>
			{/if}

			{#if stop.link !== null}
				<Button variant="outline" size="sm" class="self-start" href={stop.link.href}>
					{stop.link.label}
				</Button>
			{/if}

			<div class="mt-2 flex items-center justify-between gap-2">
				<Button variant="ghost" size="sm" onclick={() => tour.close()}>Закрыть подсказки</Button>
				<div class="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={tour.index === 0}
						onclick={() => tour.back()}
					>
						Назад
					</Button>
					<Button size="sm" onclick={() => tour.next()}>{isLast ? 'Готово' : 'Далее'}</Button>
				</div>
			</div>
		{/if}
	</div>
{/if}
