/**
 * Каталог модулей — то, из чего собираются панели карточки и что решает, какой
 * модуль действует в пространстве. Порядок панелей, скрытие панелей
 * недействующих модулей и правила стадий проверяются здесь, без базы: ошибка в
 * них видна только на показе карточки.
 */
import { describe, expect, it } from 'vitest';
import { processDefinitionSchema } from '$lib/contracts/interactions';
import { CARD_PANEL_LABELS, CARD_PANELS, processCardSchema } from '$lib/contracts/process-card';
import { defineConfig } from '$lib/platform/config';
import { defineModule, type ModuleManifest } from '$lib/platform/define';
import {
	activeModules,
	cardActionSpecs,
	headerFactSpecs,
	PANEL_CATALOG,
	panelOwner,
	requiredModules,
	visiblePanels
} from '$lib/platform/registry';
import { B2B_PROCESS, B2C_PROCESS } from '$lib/server/stages/definitions';

/** Модуль с пустыми слотами — основа для проверок конфига. */
function manifest(key: string, overrides: Partial<ModuleManifest> = {}): ModuleManifest {
	return defineModule({
		key,
		label: key,
		description: key,
		panels: [],
		headerFacts: [],
		cardActions: [],
		sections: [],
		documents: { templates: [], kinds: [] },
		requiredByStage: null,
		...overrides
	});
}

describe('каталог панелей', () => {
	it('воспроизводит прежний порядок и подписи семи панелей', () => {
		expect(PANEL_CATALOG.map((panel) => panel.key)).toEqual([
			'terms',
			'contract',
			'payment',
			'learners',
			'learning',
			'training_document',
			'documents'
		]);
		expect(CARD_PANELS).toEqual(PANEL_CATALOG.map((panel) => panel.key));
		expect(CARD_PANEL_LABELS.contract).toBe('Договор с позициями и лицензиями');
		expect(panelOwner('terms')).toBeNull();
		expect(panelOwner('learners')).toBe('learning');
		expect(panelOwner('licenses')).toBeUndefined();
	});

	it('форма редактора по-прежнему отклоняет панель вне каталога и сортирует по нему', () => {
		expect(processCardSchema.safeParse({ panels: ['licenses'] }).success).toBe(false);
		expect(processCardSchema.parse({ panels: ['documents', 'payment'] }).panels).toEqual([
			'payment',
			'documents'
		]);
	});

	it('прячет панели недействующих модулей и незнакомые ключи, панели ядра оставляет', () => {
		const chosen = ['documents', 'payment', 'contract', 'licenses', 'terms', 'learning'];

		expect(visiblePanels(chosen, ['contracts'])).toEqual(['terms', 'contract', 'documents']);
		expect(visiblePanels(chosen, [])).toEqual(['terms', 'documents']);
		expect(visiblePanels(chosen, ['payment', 'learning'])).toEqual([
			'terms',
			'payment',
			'learning',
			'documents'
		]);
	});
});

describe('модули, нужные стадиям', () => {
	it('в процессе вуза обучение нужно стадиям с потоками, договоры — передаче лицензий', () => {
		const required = requiredModules(processDefinitionSchema.parse(B2B_PROCESS).stages);

		// Ведению занятий — данные обучения, обучению преподавателей и повышению
		// квалификации — пункты, которые закрывает поток нужного назначения.
		expect(required.get('learning')).toEqual([
			'Обучение преподавателей',
			'Ведение занятий',
			'Повышение квалификации'
		]);
		expect(required.get('contracts')).toEqual(['Передача материалов и лицензий']);
		expect(required.has('payment')).toBe(false);
		expect(required.has('meetings')).toBe(false);
	});

	it('в коммерческом обучении стадиям нужны оплата и обучение', () => {
		const required = requiredModules(processDefinitionSchema.parse(B2C_PROCESS).stages);

		expect([...required.keys()]).toEqual(['payment', 'learning']);
		expect(required.get('payment')).toEqual(['Договор и оплата']);
	});

	it('действующие — включённые и нужные стадиям, в порядке конфига, без чужих ключей', () => {
		expect(
			activeModules(['meetings', 'unknown'], new Map([['learning', ['Ведение занятий']]]))
		).toEqual(['learning', 'meetings']);
	});
});

describe('слоты модулей', () => {
	it('действие приглашения есть только при действующих «Встречах»', () => {
		expect(cardActionSpecs(['contracts', 'meetings']).map((action) => action.key)).toEqual([
			'invite'
		]);
		expect(cardActionSpecs(['contracts'])).toEqual([]);
	});

	it('факт шапки выбирается по виду контрагента и действующим модулям', () => {
		const all = ['contracts', 'payment', 'learning', 'meetings'];

		expect(headerFactSpecs(all, 'person').map((fact) => fact.key)).toEqual(['price', 'payment']);
		expect(headerFactSpecs(all, 'company').map((fact) => fact.key)).toEqual(['contract', 'price']);
		expect(headerFactSpecs(['learning'], 'institution')).toEqual([]);
	});
});

describe('проверка конфига', () => {
	it('отказывает на ключе модуля не по формату', () => {
		expect(() => manifest('Acme')).toThrow('Ключ модуля');
	});

	it('отказывает на модуле, подключённом дважды', () => {
		expect(() => defineConfig({ modules: [manifest('acme'), manifest('acme')] })).toThrow(
			'подключён в конфиге дважды'
		);
	});

	it('отказывает на панели с ключом панели ядра', () => {
		const clash = manifest('acme', {
			panels: [{ key: 'documents', label: 'Документы', hint: '', order: 95 }]
		});

		expect(() => defineConfig({ modules: [clash] })).toThrow('«documents» объявлена дважды');
	});

	it('отказывает на шаблоне с двумя владельцами', () => {
		const documents = { templates: ['sublicense'], kinds: [] };

		expect(() =>
			defineConfig({
				modules: [manifest('acme', { documents }), manifest('beta', { documents })]
			})
		).toThrow('Шаблон документа «sublicense» объявляют два модуля');
	});
});
