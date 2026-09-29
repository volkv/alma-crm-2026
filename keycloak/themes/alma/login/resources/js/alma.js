/*
 * Дополнения формы входа Альма CRM поверх разметки keycloak.v2: подпись
 * «Авторизация через Keycloak» внизу карточки на каждой странице каталога,
 * строка о системе под заголовком и — только на демонстрационном стенде —
 * быстрый вход тремя учётными записями стенда.
 *
 * Разметку каталога скрипт не подменяет. Строка о системе и быстрый вход
 * появляются только на странице имени и пароля (`#kc-form-login` с полем
 * `#username`); на остальных (второй фактор, ошибки, смена пароля) скрипт
 * добавляет лишь подпись каталога. Без скрипта форма остаётся обычной формой
 * входа.
 *
 * Пароль приходит мета-тегом `alma-demo-password` из `theme.properties`, то есть
 * из переменной контейнера каталога, по которой импорт заводит демонстрационные
 * записи. Пустой тег — установка без демо-записей, блока нет.
 */
(function () {
	'use strict';

	var TAGLINE = 'От первого контакта с вузом до подтверждённого результата';

	/* Имена входа — из `keycloak/demo-users.json`, порядок — от рядовой роли к старшей. */
	var DEMO_ACCOUNTS = [
		{ login: 'manager', role: 'Менеджер' },
		{ login: 'lead', role: 'Руководитель' },
		{ login: 'admin', role: 'Администратор' }
	];

	function element(tag, className, text) {
		var node = document.createElement(tag);

		if (className) {
			node.className = className;
		}

		if (text) {
			node.textContent = text;
		}

		return node;
	}

	/* Ключ, 14px, `currentColor` — тот же рисунок, что `key-round` у иконок приложения. */
	var KEY_ICON =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
		'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
		'<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
		'<circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>';

	function demoPassword() {
		var meta = document.querySelector('meta[name="alma-demo-password"]');

		return meta === null ? '' : meta.getAttribute('content') || '';
	}

	function addTagline() {
		var title = document.getElementById('kc-page-title');

		if (title === null) {
			return;
		}

		title.insertAdjacentElement('afterend', element('p', 'alma-tagline', TAGLINE));
	}

	function addDemoPanel(form, password) {
		var username = document.getElementById('username');
		var passwordField = document.getElementById('password');
		var submit = document.getElementById('kc-login');

		if (username === null || passwordField === null) {
			return;
		}

		var panel = element('section', 'alma-demo');
		panel.setAttribute('aria-labelledby', 'alma-demo-title');
		panel.setAttribute('data-testid', 'demo-sign-in');

		var title = element('p', 'alma-demo__title', 'Демо-стенд: войти одной кнопкой');
		title.id = 'alma-demo-title';
		panel.appendChild(title);

		var buttons = element('div', 'alma-demo__buttons');

		DEMO_ACCOUNTS.forEach(function (account) {
			var button = element('button', 'pf-v5-c-button pf-m-secondary alma-demo__button');
			button.type = 'button';
			button.setAttribute('data-login', account.login);
			button.appendChild(element('span', 'alma-demo__role', account.role));
			button.appendChild(element('span', 'alma-demo__login', account.login));
			button.addEventListener('click', function () {
				username.value = account.login;
				passwordField.value = password;

				if (typeof form.requestSubmit === 'function') {
					form.requestSubmit(submit);
				} else {
					form.submit();
				}
			});
			buttons.appendChild(button);
		});

		panel.appendChild(buttons);

		var hint = element('p', 'alma-demo__hint');
		hint.appendChild(
			document.createTextNode('Или введите имя входа вручную, пароль у всех трёх общий: ')
		);
		hint.appendChild(element('code', 'alma-demo__password', password));
		panel.appendChild(hint);

		panel.appendChild(
			element(
				'p',
				'alma-demo__hint',
				'Названия вузов и продуктов настоящие, люди, договоры и цифры — вымышленные. ' +
					'Каждую ночь стенд возвращается к исходным данным.'
			)
		);

		form.insertAdjacentElement('beforebegin', panel);
	}

	function addProvider() {
		var card = document.querySelector('.pf-v5-c-login__main');

		if (card === null) {
			return;
		}

		var line = element('p', 'alma-provider');
		line.setAttribute('data-testid', 'identity-provider');
		line.insertAdjacentHTML('afterbegin', KEY_ICON);

		var text = element('span');
		text.appendChild(document.createTextNode('Авторизация через '));
		text.appendChild(element('strong', '', 'Keycloak'));
		text.appendChild(document.createTextNode(' — единый каталог учётных записей'));
		line.appendChild(text);
		card.appendChild(line);
	}

	function enhance() {
		addProvider();

		var form = document.getElementById('kc-form-login');

		if (form === null || document.getElementById('username') === null) {
			return;
		}

		addTagline();

		var password = demoPassword();

		if (password !== '') {
			addDemoPanel(form, password);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', enhance);
	} else {
		enhance();
	}
})();
