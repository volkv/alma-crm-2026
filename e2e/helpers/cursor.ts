import { type Page } from '@playwright/test';

/**
 * Что считается нажимаемым: тег или роль, по которой место опознают и человек, и
 * вспомогательная технология. Подпись попадает в список, только если внутри неё
 * переключатель, — клик по её тексту меняет состояние, тогда как подпись
 * текстового поля лишь передаёт фокус, и «палец» над ней обещал бы лишнее.
 */
const CLICKABLE = [
	'button:not([disabled])',
	'a[href]',
	'summary',
	'[role="option"]',
	'[role="menuitem"]',
	'[role="tab"]',
	'label:has([data-slot="checkbox"], [data-slot="switch"], [data-slot="radio-group-item"])'
].join(', ');

/**
 * Видимые нажимаемые места, над которыми курсор не «палец», с приметой, по
 * которой их найти глазами.
 *
 * Меряется итог `getComputedStyle`, а не наличие класса: правило может стоять в
 * примитиве, в утилите на месте или в базовом слое, и важно только то, что в
 * итоге увидит указатель. Браузер сам даёт «палец» одним ссылкам — у `<button>`
 * по умолчанию стрелка, — поэтому проверять приходится и страницу, и каждый
 * всплывающий слой: слои рисуются в конце документа и правил страницы не
 * наследуют.
 */
export async function pointerlessControls(page: Page, within = ':root'): Promise<string[]> {
	return page.evaluate(
		([selector, root]) => {
			const scope = document.querySelector(root);

			if (scope === null) {
				throw new Error(`область «${root}» на странице не найдена`);
			}

			return [...scope.querySelectorAll(selector)]
				.filter((element) => element.checkVisibility())
				.map((element) => ({ element, cursor: getComputedStyle(element).cursor }))
				.filter(({ cursor }) => cursor !== 'pointer')
				.map(({ element, cursor }) => {
					const name =
						element.getAttribute('aria-label') ?? (element.textContent ?? '').replace(/\s+/g, ' ');

					return `<${element.tagName.toLowerCase()}> «${name.trim().slice(0, 40)}» → ${cursor}`;
				});
		},
		[CLICKABLE, within] as const
	);
}
