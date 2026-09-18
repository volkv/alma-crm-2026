<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Pathname } from '$app/types';
	import { Button } from '$lib/components/ui/button/index.js';
	import { isStepScreen } from '$lib/onboarding/steps';
	import type { OnboardingTour } from '$lib/onboarding/tour.svelte';

	/**
	 * Подсказки первого входа: рамка вокруг элемента, о котором идёт речь, и
	 * карточка с шагом рядом с ней.
	 *
	 * Компонент стоит в оболочке приложения, а не на странице: тур переживает
	 * переход между экранами — шаг, чей элемент живёт в другом разделе, ведёт
	 * туда ссылкой и продолжается на месте.
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
	/** Есть ли элемент шага на этом экране. */
	let found = $state(false);
	/**
	 * Для какого шага и экрана элемент уже показали: второй раз не прокручиваем и
	 * не забираем фокус. Обычная переменная, а не руна: её читает только эффект,
	 * который сам же её и пишет, — реактивная отметка перезапускала бы его и
	 * отменяла бы то, что он только что назначил.
	 */
	let shownFor = '';

	const step = $derived(tour.step);
	const stepKey = $derived(`${step?.id ?? ''}@${page.url.pathname}`);
	const onScreen = $derived(step === null ? false : isStepScreen(step, page.url.pathname));
	// Адрес шага — обычный путь приложения без параметров; `resolve()` только
	// добавляет к нему базовый путь. Приведение — то же, что в навигации
	// оболочки: разбирать объединение всех маршрутов ради одной ветви незачем.
	const stepHref = $derived(step === null ? null : resolve(step.route.href as Pathname & '/'));
	const isLast = $derived(tour.index === tour.steps.length - 1);

	function element(): HTMLElement | null {
		const current = tour.step;

		return current === null
			? null
			: document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
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

	// Первый вход: признак «показан» лежит в браузере, и прочитать его можно
	// только здесь — на сервере тура нет.
	$effect(() => {
		tour.autoStart();
	});

	$effect(() => {
		if (!tour.open) {
			return;
		}

		let handle = requestAnimationFrame(function tick() {
			sync();
			handle = requestAnimationFrame(tick);
		});

		return () => cancelAnimationFrame(handle);
	});

	$effect(() => {
		const key = stepKey;

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
		const handle = requestAnimationFrame(() => {
			element()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
			card?.focus();
		});

		return () => cancelAnimationFrame(handle);
	});

	function onWindowKeydown(event: KeyboardEvent): void {
		// Esc — это «пропустить»: подсказки не должны стоять между человеком и
		// работой, за которой он пришёл.
		if (tour.open && event.key === 'Escape') {
			event.preventDefault();
			tour.skip();
		}
	}

	function onCardKeydown(event: KeyboardEvent): void {
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
		const stops = [...card.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
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

{#if tour.open && step !== null}
	<!-- Слой ловит нажатия мимо карточки: пока идут подсказки, шаг один, и
		случайный клик по странице не уводил бы человека из тура молча. Затемнение
		такое же лёгкое, как у диалогов (`ui/dialog`): рамка и так показывает, о
		чём речь. -->
	<div class="fixed inset-0 z-50 bg-black/10" aria-hidden="true"></div>

	{#if frame !== null}
		<div
			class="pointer-events-none fixed z-50 rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-canvas"
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
		class="fixed z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-lg focus-ring {anchor ===
		null
			? 'bottom-4 left-1/2 -translate-x-1/2'
			: ''}"
		style={anchor === null ? undefined : `top: ${anchor.top}px; left: ${anchor.left}px`}
	>
		<p class="text-xs text-muted-foreground">
			Шаг {tour.index + 1} из {tour.steps.length}
		</p>
		<h2 id={TITLE_ID} class="text-sm font-semibold">{step.title}</h2>
		<p class="text-sm text-muted-foreground">{step.body}</p>

		{#if !found}
			{#if onScreen}
				<p class="text-xs text-warning-soft-foreground">
					{step.hint ?? 'На этом экране блока сейчас нет — шаг можно пропустить.'}
				</p>
			{:else if stepHref !== null}
				<Button variant="outline" size="sm" class="self-start" href={stepHref}>
					Открыть «{step.route.label}»
				</Button>
			{/if}
		{/if}

		<div class="mt-2 flex items-center justify-between gap-2">
			<Button variant="ghost" size="sm" onclick={() => tour.skip()}>Пропустить</Button>
			<div class="flex items-center gap-2">
				<Button variant="outline" size="sm" disabled={tour.index === 0} onclick={() => tour.back()}>
					Назад
				</Button>
				<Button size="sm" onclick={() => tour.next()}>{isLast ? 'Готово' : 'Далее'}</Button>
			</div>
		</div>
	</div>
{/if}
