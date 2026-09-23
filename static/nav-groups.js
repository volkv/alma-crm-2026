/*
 * Свёрнутые группы меню до первой отрисовки.
 *
 * Какие группы человек свернул, знает только его браузер (`localStorage`), и
 * сервер рисует меню по умолчанию. Без этого файла страница показывала бы один
 * кадр с раскрытыми группами, а через мгновение схлопывала их — меню дёргалось
 * на каждой загрузке. Поэтому скрипт стоит в <head> и блокирует отрисовку:
 * работы в нём на десяток строк, а стиль обязан оказаться в документе раньше
 * первого кадра.
 *
 * Файл отдельный, а не строкой в `app.html`, из-за CSP — причина та же, что у
 * `static/theme.js`: `script-src` это `self`, и написанный руками встроенный
 * скрипт браузер бы заблокировал.
 *
 * Правило нельзя написать в `app.css` заранее: ключи групп известны только во
 * время работы — у каждого пространства свой, и приходит он из базы. Поэтому
 * скрипт собирает стиль под те группы, о которых в браузере есть запись.
 *
 * Стиль живёт ровно до оживления страницы: он висит на `data-nav-boot` у
 * <html>, и как только меню начинает распоряжаться собой само, атрибут
 * снимается (`$lib/components/app-shell/nav-groups.svelte`). Иначе первая же
 * попытка развернуть группу мышью упёрлась бы в стиль, который сильнее классов
 * разметки.
 */
(function () {
	var raw;

	// Чтения `localStorage` в приватном окне может не быть вовсе: меню тогда
	// просто встанет по умолчанию, а страница обязана открыться.
	try {
		raw = localStorage.getItem('lct-crm:nav-groups');
	} catch (_error) {
		return;
	}

	if (!raw) {
		return;
	}

	var choices;

	try {
		choices = JSON.parse(raw);
	} catch (_error) {
		return;
	}

	if (typeof choices !== 'object' || choices === null || Array.isArray(choices)) {
		return;
	}

	var css = '';

	for (var id in choices) {
		if (!Object.prototype.hasOwnProperty.call(choices, id) || typeof choices[id] !== 'boolean') {
			continue;
		}

		// Ключ группы едет в селектор, а ключ пространства заводит человек.
		// Пропускается всё, что не похоже на ключ: в стиль не должно попасть
		// ничего, кроме имени группы.
		if (!/^[A-Za-z0-9_:-]+$/.test(id)) {
			continue;
		}

		var group = 'html[data-nav-boot] [data-nav-group="' + id + '"]';

		css += group + ' [data-nav-list]{grid-template-rows:' + (choices[id] ? '0fr' : '1fr') + '}';
		css += group + ' [data-nav-chevron]{transform:' + (choices[id] ? 'rotate(-90deg)' : 'none') + '}';
	}

	if (css === '') {
		return;
	}

	document.documentElement.dataset.navBoot = '';

	var style = document.createElement('style');

	style.textContent = css;
	document.head.appendChild(style);
})();
