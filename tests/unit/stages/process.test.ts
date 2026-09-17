/**
 * Правила процесса на структурах в памяти: сопоставление по ключам, цель
 * переноса по умолчанию, сборка предпросмотра и пригодность структуры к работе.
 *
 * Все они — чистые функции, и проверяются они без базы намеренно: правило,
 * которое можно проверить только прогнав миграцию, никто не будет менять.
 */
import { describe, expect, it } from 'vitest';
import {
	buildPreview,
	defaultMigrationTarget,
	matchStages,
	validateProcessDraft,
	withDefaultRules,
	type DraftShape
} from '$lib/server/stages/process';
import { B2B_PROCESS, B2C_PROCESS } from '$lib/server/stages/definitions';

type Stage = Parameters<typeof matchStages>[0][number];

function stage(key: string, overrides: Partial<Stage> = {}): Stage {
	return {
		key,
		name: `Стадия ${key}`,
		category: 'contact',
		slaDays: 5,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		isFinal: false,
		checklist: [],
		...overrides
	};
}

describe('сопоставление стадий по ключу', () => {
	it('различает сохранённые, переименованные, изменённые, новые и удалённые', () => {
		const active = [stage('a'), stage('b'), stage('c'), stage('d')];
		const draft = [
			stage('a'),
			stage('b', { name: 'Другое название' }),
			stage('c', { slaDays: 9 }),
			stage('e')
		];

		const matches = matchStages(active, draft);
		const by = new Map(matches.map((match) => [match.key, match]));

		expect(by.get('a')?.change).toBe('kept');
		expect(by.get('b')?.change).toBe('renamed');
		expect(by.get('c')?.change).toBe('changed');
		expect(by.get('d')?.change).toBe('removed');
		expect(by.get('e')?.change).toBe('added');
	});

	it('переименование отличается от «удалили и добавили»', () => {
		// Ключ тот же — значит, стадия та же, и записи на ней остаются на месте.
		const renamed = matchStages([stage('signing')], [stage('signing', { name: 'Подписание' })]);

		expect(renamed.map((match) => match.change)).toEqual(['renamed']);

		// Другой ключ — другая работа: одна стадия исчезла, другая появилась.
		const replaced = matchStages([stage('signing')], [stage('sign_off')]);

		expect(replaced.map((match) => match.change).sort()).toEqual(['added', 'removed']);
	});

	it('называет по фразе на каждый изменённый параметр', () => {
		const matches = matchStages(
			[stage('a')],
			[stage('a', { name: 'Иначе', slaDays: 10, requiresResult: true })]
		);

		expect(matches[0].change).toBe('changed');
		expect(matches[0].changes.join('; ')).toMatch(/название/);
		expect(matches[0].changes.join('; ')).toMatch(/норматив/);
		expect(matches[0].changes.join('; ')).toMatch(/требовать результат/);
	});

	it('одинаковые ключи разных групп не смешиваются: сопоставляют по одной группе', () => {
		// Функция принимает структуры одной группы; ключ `learning` есть и в `b2c`,
		// и мог бы появиться в `b2b` — сопоставление за пределы переданного набора
		// не выходит, поэтому «новая» стадия остаётся новой.
		const matches = matchStages([stage('classes')], [stage('classes'), stage('learning')]);

		expect(matches.find((match) => match.key === 'learning')?.change).toBe('added');
		expect(matches.find((match) => match.key === 'classes')?.change).toBe('kept');
	});
});

describe('цель переноса по умолчанию', () => {
	const order = ['one', 'two', 'three', 'four'];

	it('предыдущая сохранившаяся стадия', () => {
		const surviving = new Set(['one', 'two', 'four']);

		expect(defaultMigrationTarget(order, 'three', surviving)).toBe('two');
	});

	it('для первой — следующая: предыдущей у неё нет', () => {
		const surviving = new Set(['two', 'three', 'four']);

		expect(defaultMigrationTarget(order, 'one', surviving)).toBe('two');
	});

	it('перешагивает подряд удалённые стадии', () => {
		const surviving = new Set(['one', 'four']);

		expect(defaultMigrationTarget(order, 'three', surviving)).toBe('one');
	});

	it('без единой сохранившейся стадии цели нет', () => {
		expect(defaultMigrationTarget(order, 'two', new Set())).toBeNull();
	});
});

describe('правила переноса черновика', () => {
	const activeRevision = {
		id: 'r1',
		groupId: 'g1',
		version: 1,
		name: 'Процесс',
		note: null,
		publishedAt: new Date(),
		stages: ['one', 'two', 'three'].map((key, index) => ({
			id: `s-${key}`,
			revisionId: 'r1',
			position: index + 1,
			...stage(key)
		})),
		transitions: [],
		migrationRules: []
	};

	it('дополняет умолчанием только исчезнувшие ключи', () => {
		const filled = withDefaultRules(
			{
				name: 'Процесс',
				note: null,
				stages: [stage('one'), stage('three')],
				transitions: [],
				migrationRules: []
			},
			activeRevision
		);

		expect(filled.migrationRules).toEqual([{ removedStageKey: 'two', targetStageKey: 'one' }]);
	});

	it('не переписывает явный выбор администратора', () => {
		const filled = withDefaultRules(
			{
				name: 'Процесс',
				note: null,
				stages: [stage('one'), stage('three')],
				transitions: [],
				migrationRules: [{ removedStageKey: 'two', targetStageKey: 'three' }]
			},
			activeRevision
		);

		expect(filled.migrationRules).toEqual([{ removedStageKey: 'two', targetStageKey: 'three' }]);
	});

	it('отбрасывает правило по стадии, которой в действующей структуре не было', () => {
		const filled = withDefaultRules(
			{
				name: 'Процесс',
				note: null,
				stages: [stage('one'), stage('two'), stage('three')],
				transitions: [],
				migrationRules: [{ removedStageKey: 'never-existed', targetStageKey: 'one' }]
			},
			activeRevision
		);

		expect(filled.migrationRules).toEqual([]);
	});
});

describe('пригодность структуры к работе', () => {
	/** Линейная цепочка: то, что должно проходить без единой претензии. */
	function chain(): DraftShape {
		return {
			stages: [
				{ key: 'one', name: 'Первая', position: 1, category: 'contact', isFinal: false },
				{ key: 'two', name: 'Вторая', position: 2, category: 'documents', isFinal: false },
				{ key: 'three', name: 'Третья', position: 3, category: 'control', isFinal: true }
			],
			transitions: [
				{ fromStageKey: 'one', toStageKey: 'two', kind: 'forward' },
				{ fromStageKey: 'two', toStageKey: 'three', kind: 'forward' }
			],
			migrationRules: []
		};
	}

	it('молчит о правильной структуре', () => {
		expect(validateProcessDraft(chain())).toEqual([]);
	});

	it('1. у нефинальной стадии нет перехода вперёд', () => {
		const draft = chain();
		draft.transitions = draft.transitions.filter((transition) => transition.fromStageKey !== 'two');

		expect(validateProcessDraft(draft).join('; ')).toMatch(/нет перехода вперёд/);
	});

	it('2. переход вперёд ведёт назад по порядку стадий', () => {
		const draft = chain();
		draft.transitions.push({ fromStageKey: 'three', toStageKey: 'one', kind: 'forward' });

		expect(validateProcessDraft(draft).join('; ')).toMatch(/ведёт назад по порядку/);
	});

	it('2. возврат ведёт вперёд по порядку стадий', () => {
		const draft = chain();
		draft.transitions.push({ fromStageKey: 'one', toStageKey: 'three', kind: 'return' });

		expect(validateProcessDraft(draft).join('; ')).toMatch(/ведёт вперёд по порядку/);
	});

	it('3. из стадии не добраться до финальной', () => {
		const draft = chain();
		draft.stages.push({
			key: 'four',
			name: 'Тупик',
			position: 4,
			category: 'control',
			isFinal: false
		});
		draft.transitions.push({ fromStageKey: 'three', toStageKey: 'four', kind: 'forward' });

		expect(validateProcessDraft(draft).join('; ')).toMatch(/не добраться ни до одной финальной/);
	});

	it('4. финальной стадии нет вовсе', () => {
		const draft = chain();
		draft.stages[2].isFinal = false;

		expect(validateProcessDraft(draft).join('; ')).toMatch(/нет ни одной финальной стадии/);
	});

	it('5. на первую стадию ведёт переход вперёд', () => {
		const draft = chain();
		draft.transitions.push({ fromStageKey: 'three', toStageKey: 'one', kind: 'forward' });

		const issues = validateProcessDraft(draft).join('; ');

		// Первая стадия — только стартовая: переход, ведущий на неё вперёд, означал
		// бы, что процесс начинается дважды. Про ту же структуру говорится и
		// правилом 2 — намеренно: два разных объяснения одного и того же
		// администратор читает как две разные ошибки и исправляет одну правку.
		expect(issues).toMatch(/начало процесса одно/);
		expect(issues).toMatch(/ведёт назад по порядку/);
	});

	it('называет повтор позиции и стадию, названную кодом своей группы', () => {
		const draft = chain();
		draft.stages[1].position = 1;
		draft.stages[1].name = 'documents';

		const issues = validateProcessDraft(draft).join('; ');

		expect(issues).toMatch(/Позиция 1 занята двумя стадиями/);
		expect(issues).toMatch(/названа кодом своей смысловой группы/);
	});

	it('не пускает стадию под архивным ключом и пускает тот же ключ в другой группе', () => {
		const draft = chain();

		expect(
			validateProcessDraft(draft, {
				archivedKeys: new Set(['two']),
				activeOrderedKeys: [],
				openByKey: new Map()
			}).join('; ')
		).toMatch(/уже был в этой группе и снят/);

		// Тот же ключ в группе, где он никогда не встречался, — законная стадия.
		expect(
			validateProcessDraft(draft, {
				archivedKeys: new Set(),
				activeOrderedKeys: [],
				openByKey: new Map()
			})
		).toEqual([]);
	});

	it('требует правило переноса там, где на исчезнувшей стадии кто-то стоит', () => {
		const draft = chain();

		const issues = validateProcessDraft(draft, {
			archivedKeys: new Set(),
			activeOrderedKeys: ['one', 'two', 'three', 'gone'],
			openByKey: new Map([['gone', 4]])
		});

		expect(issues.join('; ')).toMatch(/На стадии «gone» стоит незавершённых взаимодействий: 4/);

		// Без единой записи на исчезнувшей стадии правило не нужно: переносить
		// некого, и требовать решение там, где его последствий нет, незачем.
		expect(
			validateProcessDraft(draft, {
				archivedKeys: new Set(),
				activeOrderedKeys: ['one', 'two', 'three', 'gone'],
				openByKey: new Map()
			})
		).toEqual([]);
	});

	it('правила удаления: единственная, первая и финальная стадия', () => {
		// Единственную стадию удалить нельзя: процесса без стадий не существует —
		// структура без стадий претензию получает сразу.
		expect(validateProcessDraft({ stages: [], transitions: [], migrationRules: [] })).toEqual([
			'В процессе нет ни одной стадии'
		]);

		// Первую удалить можно: новой первой становится следующая, и переходов
		// вперёд на неё не ведёт.
		const withoutFirst: DraftShape = {
			stages: [
				{ key: 'two', name: 'Вторая', position: 1, category: 'documents', isFinal: false },
				{ key: 'three', name: 'Третья', position: 2, category: 'control', isFinal: true }
			],
			transitions: [{ fromStageKey: 'two', toStageKey: 'three', kind: 'forward' }],
			migrationRules: [{ removedStageKey: 'one', targetStageKey: 'two' }]
		};

		expect(
			validateProcessDraft(withoutFirst, {
				archivedKeys: new Set(),
				activeOrderedKeys: ['one', 'two', 'three'],
				openByKey: new Map([['one', 2]])
			})
		).toEqual([]);

		// Финальную удалить можно, если остаётся другая финальная.
		const withoutOneFinal: DraftShape = {
			stages: [
				{ key: 'one', name: 'Первая', position: 1, category: 'contact', isFinal: false },
				{ key: 'two', name: 'Вторая', position: 2, category: 'control', isFinal: true }
			],
			transitions: [{ fromStageKey: 'one', toStageKey: 'two', kind: 'forward' }],
			migrationRules: [{ removedStageKey: 'three', targetStageKey: 'two' }]
		};

		expect(
			validateProcessDraft(withoutOneFinal, {
				archivedKeys: new Set(),
				activeOrderedKeys: ['one', 'two', 'three'],
				openByKey: new Map([['three', 1]])
			})
		).toEqual([]);
	});
});

describe('сборка предпросмотра', () => {
	it('считает итог, разбивку и отмечает стадию, на которой никого нет', () => {
		const preview = buildPreview({
			groupId: 'g1',
			matches: matchStages(
				[stage('one'), stage('two'), stage('three')],
				[stage('one'), stage('three', { name: 'Иначе' })]
			),
			openByKey: new Map([
				['one', 3],
				['two', 5]
			]),
			migrationRules: [{ removedStageKey: 'two', targetStageKey: 'one' }],
			nameByKey: new Map([
				['one', 'Стадия one'],
				['three', 'Иначе']
			]),
			issues: []
		});

		const rows = new Map(preview.rows.map((row) => [row.stageKey, row]));

		// Затронуты только переезжающие: перепривязка записи к стадии с тем же
		// ключом человеку не видна и в число «затронуто» не идёт.
		expect(preview.affected).toBe(5);
		expect(rows.get('two')?.targetStageName).toBe('Стадия one');
		expect(rows.get('one')?.interactions).toBe(3);
		expect(rows.get('three')?.change).toBe('renamed');
		// На стадии `three` никого нет — строка про неё остаётся с нулём.
		expect(rows.get('three')?.interactions).toBe(0);
	});

	it('переносит претензии проверки в предпросмотр', () => {
		const preview = buildPreview({
			groupId: 'g1',
			matches: [],
			openByKey: new Map(),
			migrationRules: [],
			nameByKey: new Map(),
			issues: ['В процессе нет ни одной стадии']
		});

		expect(preview.issues).toEqual(['В процессе нет ни одной стадии']);
		expect(preview.affected).toBe(0);
	});
});

describe('процессы поставки', () => {
	it('проходят те же правила, что и черновик администратора', () => {
		for (const definition of [B2B_PROCESS, B2C_PROCESS]) {
			const draft: DraftShape = {
				stages: definition.stages.map((item, index) => ({
					key: item.key,
					name: item.name,
					position: index + 1,
					category: item.category,
					isFinal: item.isFinal
				})),
				transitions: definition.transitions.map((transition) => ({
					fromStageKey: transition.fromStageKey,
					toStageKey: transition.toStageKey,
					kind: transition.kind
				})),
				migrationRules: []
			};

			expect(validateProcessDraft(draft)).toEqual([]);
		}
	});
});
