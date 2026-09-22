/**
 * Главное меню против прав и против состава пространств.
 *
 * Раздел, на который у человека нет права, отвечает 403 — показывать на него
 * ссылку значит обещать то, чего учётная запись не может. Проверяется именно
 * фильтр: он один на боковую панель и на выдвижную навигацию телефона.
 *
 * Секции пространств приходят из базы, поэтому меню перестало быть постоянным
 * списком: проверяется и то, что постоянные заголовки стоят на своих местах, и
 * то, что направления встают между ними.
 */
import { describe, expect, it } from 'vitest';
import { groupedSections, navSections, visibleSections, type NavWorkspace } from '$lib/nav';
import { DEFAULT_ROLES, PERMISSIONS } from '$lib/server/rbac/permissions';
import { SETTINGS_SECTIONS } from '../../src/routes/(app)/settings/sections';

/** Два пространства стенда: по ним же собирается меню в работе. */
const WORKSPACES: NavWorkspace[] = [
	{ key: 'b2b', name: 'Учебные заведения', hasWorkflow: true },
	{ key: 'b2c', name: 'Корпоративное обучение', hasWorkflow: true }
];

/** Права роли из каталога — те же, что сидируются в базу. */
function permissionsOf(roleId: string): ReadonlySet<string> {
	const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);

	if (role === undefined) {
		throw new Error(`Роль «${roleId}» не заведена в каталоге`);
	}

	return new Set<string>(role.permissions);
}

function labels(permissions: ReadonlySet<string>): string[] {
	return visibleSections(navSections(WORKSPACES), permissions).map((section) => section.label);
}

describe('разделы меню', () => {
	it('называют право из каталога или не требуют никакого', () => {
		for (const section of navSections(WORKSPACES)) {
			if (section.permission !== null) {
				expect(PERMISSIONS).toHaveProperty(section.permission);
			}
		}
	});

	it('открыты администратору целиком', () => {
		expect(labels(permissionsOf('admin'))).toEqual(
			navSections(WORKSPACES).map((section) => section.label)
		);
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
			'Отчёты',
			'Документы',
			// По пункту на пространство: раздел взаимодействий теперь принадлежит
			// направлению, а не общей «Главной».
			'Взаимодействия',
			'Взаимодействия',
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
	it('ставят направления между «Главным» и «Справочниками»', () => {
		const grouped = groupedSections(navSections(WORKSPACES)).map((group) => [
			group.label,
			group.sections.map((section) => section.label)
		]);

		expect(grouped).toEqual([
			['Главное', ['Сводка', 'Отчёты', 'Документы']],
			['Учебные заведения', ['Взаимодействия']],
			['Корпоративное обучение', ['Взаимодействия']],
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
					'Пространства',
					'Процесс',
					'Интеграции',
					'Уведомления',
					'Внешние системы'
				]
			],
			['Остальное', ['Журнал', 'Справка']]
		]);
	});

	it('различают секции пространств по ключу, а не по подписи пункта', () => {
		// Подпись у обеих одна — «Взаимодействия», — и если бы группы совпадали
		// тоже, два направления слились бы в панели в одну секцию.
		const ids = groupedSections(navSections(WORKSPACES)).map((group) => group.id);

		expect(ids).toContain('workspace:b2b');
		expect(ids).toContain('workspace:b2c');
	});

	it('обходятся без направлений вовсе: постоянные заголовки на своих местах', () => {
		const grouped = groupedSections(navSections([])).map((group) => group.label);

		expect(grouped).toEqual(['Главное', 'Справочники', 'Настройки', 'Остальное']);
	});

	it('показывают пространство без процесса: оно заведено, и это видно', () => {
		const grouped = groupedSections(
			navSections([{ key: 'new', name: 'Новое направление', hasWorkflow: false }])
		).map((group) => group.label);

		expect(grouped).toContain('Новое направление');
	});

	it('не показывают заголовок над пустой группой', () => {
		// Без единого права остаются «Сводка», «Профиль» и «Справка» — заголовку
		// «Справочники» над ничем стоять незачем, как и заголовкам направлений.
		const grouped = groupedSections(visibleSections(navSections(WORKSPACES), new Set()));

		expect(grouped.map((group) => group.label)).toEqual(['Главное', 'Настройки', 'Остальное']);
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
	const menu = navSections(WORKSPACES).filter((section) => section.href.startsWith('/settings'));

	it('стоят в меню все до одного и тем же правом', () => {
		expect(menu.map((section) => [section.href, section.label, section.permission])).toEqual(
			SETTINGS_SECTIONS.map((section) => [section.href, section.label, section.permission])
		);
	});

	it('лежат в группе «Настройки»', () => {
		for (const section of menu) {
			expect(section.group.id, section.href).toBe('settings');
		}
	});
});
