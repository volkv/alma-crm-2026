/**
 * Главное меню против прав.
 *
 * Раздел, на который у человека нет права, отвечает 403 — показывать на него
 * ссылку значит обещать то, чего учётная запись не может. Проверяется именно
 * фильтр: он один на боковую панель и на выдвижную навигацию телефона.
 */
import { describe, expect, it } from 'vitest';
import { groupedSections, navGroups, navSections, visibleSections } from '$lib/nav';
import { DEFAULT_ROLES, PERMISSIONS } from '$lib/server/rbac/permissions';
import { SETTINGS_SECTIONS } from '../../src/routes/(app)/settings/sections';

/** Права роли из каталога — те же, что сидируются в базу. */
function permissionsOf(roleId: string): ReadonlySet<string> {
	const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);

	if (role === undefined) {
		throw new Error(`Роль «${roleId}» не заведена в каталоге`);
	}

	return new Set<string>(role.permissions);
}

function labels(permissions: ReadonlySet<string>): string[] {
	return visibleSections(navSections, permissions).map((section) => section.label);
}

describe('разделы меню', () => {
	it('называют право из каталога или не требуют никакого', () => {
		for (const section of navSections) {
			if (section.permission !== null) {
				expect(PERMISSIONS).toHaveProperty(section.permission);
			}
		}
	});

	it('открыты администратору целиком', () => {
		expect(labels(permissionsOf('admin'))).toEqual(navSections.map((section) => section.label));
	});

	it('прячут журнал от роли без права на него', () => {
		const menu = labels(permissionsOf('manager'));

		expect(menu).not.toContain('Журнал');
		expect(menu).toContain('Взаимодействия');
	});

	it('оставляют «Сводку», «Профиль» и «Справку» даже без единого права: они есть у каждого', () => {
		expect(labels(new Set())).toEqual(['Сводка', 'Профиль', 'Справка']);
	});

	it('оставляют менеджеру всё, кроме журнала, и в том же порядке', () => {
		expect(labels(permissionsOf('manager'))).toEqual([
			'Сводка',
			'Взаимодействия',
			'Отчёты',
			'Документы',
			'Организации',
			'Контакты',
			'Программы',
			'Продукты',
			'Направления',
			'Данные об обучении',
			'Профиль',
			'Справка'
		]);
	});

	it('открывают журнал руководителю: свой срез он видит', () => {
		expect(labels(permissionsOf('lead'))).toContain('Журнал');
	});

	it('открывают руководителю уведомления и прячут их от менеджера', () => {
		// Эскалация зависшего взаимодействия приходит руководителю — и вопрос
		// «почему мне не пришло» задаёт он же.
		expect(labels(permissionsOf('lead'))).toContain('Уведомления');
		expect(labels(permissionsOf('manager'))).not.toContain('Уведомления');
	});
});

describe('группы меню', () => {
	it('идут в порядке каталога групп, и список разделов отсортирован по ним', () => {
		// Палитра команд показывает разделы плоским списком «в порядке меню»:
		// порядок пунктов обязан совпадать с порядком групп, иначе меню и палитра
		// расскажут о продукте по-разному.
		const order = navSections.map((section) => navGroups.findIndex((g) => g.id === section.group));

		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('кладут ежедневную работу в «Главную», каталоги в «Справочники», правила в «Настройки»', () => {
		const grouped = groupedSections(navSections).map((group) => [
			group.label,
			group.sections.map((section) => section.label)
		]);

		expect(grouped).toEqual([
			['Главная', ['Сводка', 'Взаимодействия', 'Отчёты', 'Документы']],
			[
				'Справочники',
				['Организации', 'Контакты', 'Программы', 'Продукты', 'Направления', 'Данные об обучении']
			],
			[
				'Настройки',
				[
					'Общие',
					'Профиль',
					'Пользователи',
					'Ключи доступа',
					'Процесс',
					'Интеграции',
					'Уведомления',
					'Внешние системы'
				]
			],
			['Остальное', ['Журнал', 'Справка']]
		]);
	});

	it('не показывают заголовок над пустой группой', () => {
		// Без единого права остаются «Сводка», «Профиль» и «Справка» — заголовку
		// «Справочники» над ничем стоять незачем.
		const grouped = groupedSections(visibleSections(navSections, new Set()));

		expect(grouped.map((group) => group.label)).toEqual(['Главная', 'Настройки', 'Остальное']);
	});
});

describe('подразделы настроек', () => {
	/**
	 * Пункты меню и таблица подразделов описывают одно и то же множество
	 * экранов. Список подразделов остаётся: из него оболочка раздела берёт
	 * название и подпись для заголовка, и по нему же загрузчик отвечает отказом
	 * по прямой ссылке. Разойтись им нельзя — пункт меню с чужим правом либо
	 * покажет ссылку на отказ, либо спрячет открытый экран.
	 */
	const menu = navSections.filter((section) => section.href.startsWith('/settings'));

	it('стоят в меню все до одного и тем же правом', () => {
		expect(menu.map((section) => [section.href, section.label, section.permission])).toEqual(
			SETTINGS_SECTIONS.map((section) => [section.href, section.label, section.permission])
		);
	});

	it('лежат в группе «Настройки»', () => {
		for (const section of menu) {
			expect(section.group, section.href).toBe('settings');
		}
	});
});
