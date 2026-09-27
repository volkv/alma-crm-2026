/**
 * Модель карточки взаимодействия: у каждого факта одно место.
 *
 * Функции чистые и проверяются без базы. Здесь сторожатся правила, ради
 * которых модель и заведена: отказ перехода объясняется условиями стадии, а
 * не повтором их же словами сервера; срок и тишина называются словами; лента
 * событий собирает всё по одному разу и по времени.
 */
import { describe, expect, it } from 'vitest';
import {
	buildCard,
	buildEvents,
	buildPayment,
	buildQuiet,
	buildRequirements,
	buildTiming,
	describeUncountedGroup,
	purposeCountingStages,
	type CardSource
} from '$lib/components/interaction-card/model';
import type {
	InteractionStatusView,
	InteractionSummaryView,
	StageEntryView,
	TransitionOptionView
} from '$lib/contracts/interactions';
import { INSTALLED_MODULES } from '$lib/platform/registry';

const NOW = new Date('2026-09-23T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

function entry(overrides: Partial<StageEntryView> = {}): StageEntryView {
	return {
		id: 'entry-current',
		stageId: 'stage-classes',
		snapshot: {
			key: 'classes',
			name: 'Ведение занятий',
			position: 11,
			category: 'teaching',
			slaDays: 30,
			staleAfterDays: 21,
			requiresResult: true,
			requiresConfirmation: false,
			requiresLmsData: true,
			requiresDocumentMark: null,
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			isFinal: false,
			checklist: [
				{ key: 'schedule_published', label: 'Опубликовано расписание', required: true },
				{ key: 'midterm_review', label: 'Проведён промежуточный разбор', required: false }
			]
		},
		enteredAt: daysAgo(25),
		leftAt: null,
		outcome: null,
		outcomeReason: null,
		responsibleUserId: 'user-1',
		responsibleName: 'Зотов Илья',
		waitingPartyId: null,
		resultText: null,
		confirmation: null,
		confirmedAt: null,
		lmsEvidence: null,
		documentMarkEvidence: null,
		checklistState: {},
		facts: {},
		documents: [],
		dueAt: new Date(NOW.getTime() + 5 * DAY),
		pausedSeconds: 0,
		activeSeconds: 25 * 24 * 3600,
		remainingSeconds: 5 * 24 * 3600,
		overdueSeconds: 0,
		isOverdue: false,
		isPaused: false,
		pauses: [],
		...overrides
	};
}

function forward(allowed: boolean, reasons: string[]): TransitionOptionView {
	return {
		transition: {
			id: 'transition-forward',
			fromStageId: 'stage-classes',
			toStageId: 'stage-docs',
			kind: 'forward',
			requiresReason: false,
			requiredPermissionKey: 'stages.advance'
		},
		toStage: {
			id: 'stage-docs',
			key: 'documentation_update',
			name: 'Актуализация документации',
			position: 12,
			category: 'update'
		},
		allowed,
		reasons
	};
}

function summary(overrides: Partial<InteractionSummaryView> = {}): InteractionSummaryView {
	return {
		happening: {
			stage: {
				id: 'stage-classes',
				key: 'classes',
				name: 'Ведение занятий',
				position: 11,
				category: 'teaching'
			},
			dueAt: new Date(NOW.getTime() + 5 * DAY),
			remainingSeconds: 5 * 24 * 3600,
			isOverdue: false,
			isPaused: false,
			pause: null,
			waitingParty: null,
			nextAction: null
		},
		blocking: { blockers: [], openChecklist: [] },
		whoActs: { responsibleUser: { id: 'user-1', name: 'Зотов Илья' }, waitingParty: null },
		canDo: { transitions: [forward(true, [])], actions: ['comment', 'pause'] },
		...overrides
	};
}

function status(overrides: Partial<InteractionStatusView> = {}): InteractionStatusView {
	return {
		interactionId: 'interaction-1',
		workspaceId: 'workspace-b2b',
		revision: 1,
		current: entry(),
		history: [],
		progress: [],
		blockers: [],
		isStale: false,
		lastActivityAt: daysAgo(2),
		migratedFrom: null,
		...overrides
	};
}

const NO_EXCHANGE: CardSource['exchange'] = {
	groups: [],
	nextStreamNumber: 1,
	programs: [],
	products: [],
	canSend: true,
	canComplete: true,
	canManageRoster: true,
	canExportRoster: true,
	withdrawnLearners: {},
	issue: null,
	learningStages: [],
	learners: null
};

function source(overrides: Partial<CardSource> = {}): CardSource {
	return {
		interaction: {
			id: 'interaction-1',
			title: 'УКЦТ: ведение занятий',
			status: 'active',
			workspaceId: 'workspace-b2b',
			workspaceKey: 'b2b',
			workspaceName: 'Работа с ВУЗ',
			agreementPeriodStart: null,
			agreementPeriodEnd: null,
			academicPeriodStart: null,
			academicPeriodEnd: null,
			ownerUserId: 'user-1',
			ownerName: 'Зотов Илья',
			lastActivityAt: daysAgo(2),
			externalSource: null,
			externalId: null,
			createdAt: daysAgo(160),
			updatedAt: daysAgo(2),
			editVersion: 1,
			parties: [],
			programs: [],
			products: [],
			contract: null,
			documents: []
		},
		status: status(),
		summary: summary(),
		closing: {
			complete: { allowed: false, requiresForce: true, reasons: ['Стадия не последняя'] },
			cancel: { allowed: true, reasons: [] }
		},
		comments: [],
		changes: [],
		counterparty: null,
		exchange: NO_EXCHANGE,
		paymentFact: null,
		card: {
			panels: ['terms', 'contract', 'learning', 'documents'],
			templates: ['agreement'],
			counterpartyKind: 'educational_institution'
		},
		modules: INSTALLED_MODULES.map((module) => module.key),
		...overrides
	};
}

describe('вид карточки', () => {
	it('физическое лицо: панели из процесса, в шапке оплата из чек-листа стадии', () => {
		const paid = entry({
			snapshot: {
				...entry().snapshot,
				key: 'contract_payment',
				name: 'Договор и оплата',
				checklist: [{ key: 'payment_received', label: 'Оплата получена', required: true }]
			},
			checklistState: { payment_received: true },
			leftAt: daysAgo(3)
		});
		const card = buildCard(
			source({
				status: status({ history: [paid] }),
				card: {
					panels: ['terms', 'payment', 'learners', 'learning', 'training_document', 'documents'],
					templates: [],
					counterpartyKind: 'individual'
				}
			}),
			NOW
		);

		expect(card.shape).toBe('person');
		expect(card.panels).not.toContain('contract');
		expect(card.payment).toEqual({
			tone: 'success',
			text: 'Оплата получена',
			stageName: 'Договор и оплата',
			site: null
		});
	});

	it('панель модуля, который в пространстве не действует, не рисуется; панели ядра остаются', () => {
		const card = buildCard(source({ modules: ['contracts'] }), NOW);

		expect(card.panels).toEqual(['terms', 'contract', 'documents']);
	});

	it('оплата, загруженная выгрузкой сайта, называет заявку, поток и день загрузки', () => {
		const card = buildCard(
			source({
				paymentFact: {
					orderId: 'ORD-20260313051569-QWERTY',
					streamNumber: 1,
					loadedAt: new Date('2026-09-20T09:00:00Z'),
					stageName: 'Договор и оплата'
				}
			}),
			NOW
		);

		expect(card.payment.site).toBe(
			'Оплата с сайта: заявка ORD-20260313051569-QWERTY, поток 1, загружено 20.09.2026'
		);
	});

	it('оплата с сайта до стадии оплаты — «оплачено на сайте», а не «не отмечена»', () => {
		const payment = buildPayment([entry()], {
			orderId: 'ORD-1',
			streamNumber: 2,
			loadedAt: new Date('2026-09-20T09:00:00Z'),
			stageName: 'Договор и оплата'
		});

		expect(payment).toEqual({
			tone: 'info',
			text: 'Оплачено на сайте — отметится на стадии «Договор и оплата»',
			stageName: null,
			site: 'Оплата с сайта: заявка ORD-1, поток 2, загружено 20.09.2026'
		});
	});
});

describe('условия перехода', () => {
	it('собирает чек-лист, результат и итог обучения из снимка стадии', () => {
		const requirements = buildRequirements(
			entry({ checklistState: { schedule_published: true } }),
			source({ modules: INSTALLED_MODULES.map((module) => module.key) })
		);

		expect(requirements.map((item) => [item.key, item.done, item.required])).toEqual([
			['checklist:schedule_published', true, true],
			['checklist:midterm_review', false, false],
			['result', false, true],
			['lms', false, true]
		]);
	});

	it('отказ, объяснённый условиями стадии, не повторяет их словами сервера', () => {
		const card = buildCard(
			source({
				summary: summary({
					canDo: {
						transitions: [
							forward(false, ['Не закрыт обязательный пункт чек-листа: «Опубликовано расписание»'])
						],
						actions: []
					}
				})
			}),
			NOW
		);

		expect(card.action.kind).toBe('forward');
		if (card.action.kind !== 'forward') return;
		expect(card.action.allowed).toBe(false);
		expect(card.action.otherReasons).toEqual([]);
		expect(
			card.action.requirements.filter((item) => item.required && !item.done).map((item) => item.key)
		).toContain('checklist:schedule_published');
	});

	it('отказ, которого условия не объясняют, показывается словами сервера', () => {
		const done = entry({
			checklistState: { schedule_published: true },
			resultText: 'Занятия идут',
			lmsEvidence: { kind: 'manual' }
		});
		const card = buildCard(
			source({
				status: status({ current: done }),
				summary: summary({
					canDo: {
						transitions: [forward(false, ['Недостаточно прав: требуется «stages.advance»'])],
						actions: []
					}
				})
			}),
			NOW
		);

		if (card.action.kind !== 'forward') throw new Error('ожидался шаг вперёд');
		expect(card.action.otherReasons).toEqual(['Недостаточно прав: требуется «stages.advance»']);
	});
});

describe('меню «Ещё»', () => {
	it('держит все команды, кроме главной: возврат, паузу, помеху, передачу, закрытие', () => {
		const back: TransitionOptionView = {
			...forward(true, []),
			transition: { ...forward(true, []).transition, id: 'transition-back', kind: 'return' },
			toStage: { ...forward(true, []).toStage, id: 'stage-prev', name: 'Подготовка' }
		};
		const card = buildCard(
			source({
				summary: summary({
					canDo: {
						transitions: [forward(true, []), back],
						actions: ['pause', 'raise_blocker', 'set_responsible', 'set_result', 'confirm']
					}
				})
			}),
			NOW
		);

		expect(card.primary).toMatchObject({ kind: 'transition', transition: 'forward' });
		expect(card.secondary.map((item) => item.command.kind)).toEqual([
			'transition',
			'pause',
			'module',
			'confirm',
			'raise-blocker',
			'assign',
			'complete',
			'cancel'
		]);
		expect(card.secondary[0].label).toBe('Вернуть на «Подготовка»');
		// Результат стадия требует и он не записан — он стоит условием у главной
		// кнопки, а не вторым входом в меню.
		expect(card.secondary.some((item) => item.command.kind === 'result')).toBe(false);
	});

	it('приглашение на встречу — в меню и у пункта, которому его выбрал процесс, пока «Встречи» действуют', () => {
		const meeting = entry({
			snapshot: {
				...entry().snapshot,
				key: 'meeting',
				name: 'Встреча с представителями',
				requiresLmsData: false,
				checklist: [
					{
						key: 'meeting_scheduled',
						label: 'Встреча назначена',
						required: true,
						help: 'Назначьте встречу кнопкой',
						action: 'meetings:invite'
					}
				]
			}
		});
		const invite = { kind: 'module', module: 'meetings', action: 'invite' };
		const scheduled = {
			id: 'change-meeting',
			changedAt: daysAgo(1),
			authorId: 'user-1',
			authorName: 'Зотов Илья',
			field: 'meetings:scheduled',
			oldValue: null,
			newValue: 'Назначена встреча: 01.10.2026, 11:00 по Москве, 60 мин',
			oldLabel: null,
			newLabel: null,
			reason: null
		};
		const build = (modules: CardSource['modules']) =>
			buildCard(
				source({ status: status({ current: meeting }), modules, changes: [scheduled] }),
				NOW
			);

		const withMeetings = build(['meetings']);

		expect(withMeetings.secondary.map((item) => item.command)).toContainEqual(invite);
		if (withMeetings.action.kind !== 'forward') throw new Error('ожидался шаг вперёд');
		// Пункт ручной: встречу назначили — это видно рядом, но отмечает человек.
		expect(withMeetings.action.requirements[0]).toMatchObject({
			key: 'checklist:meeting_scheduled',
			close: 'check',
			done: false,
			cta: 'Пригласить на встречу',
			command: invite,
			hint: 'Назначьте встречу кнопкой',
			note: 'Назначена встреча: 01.10.2026, 11:00 по Москве, 60 мин'
		});
		expect(withMeetings.events.find((event) => event.id === 'change:change-meeting')?.title).toBe(
			'Назначена встреча: 01.10.2026, 11:00 по Москве, 60 мин'
		);

		const without = build([]);

		expect(without.secondary.some((item) => item.command.kind === 'module')).toBe(false);
		if (without.action.kind !== 'forward') throw new Error('ожидался шаг вперёд');
		expect(without.action.requirements[0]).toMatchObject({ cta: null, command: null });
	});
});

describe('срок и тишина словами', () => {
	it('просрочка — одной фразой с датой срока', () => {
		const overdue = summary({
			happening: { ...summary().happening, dueAt: daysAgo(55), isOverdue: true }
		});

		expect(buildTiming(overdue, NOW)).toEqual({
			tone: 'danger',
			text: 'просрочено на 55 дней',
			detail: 'срок был 30.07.2026'
		});
	});

	it('пауза говорит, кого ждём, а не сколько осталось', () => {
		const paused = summary({
			happening: { ...summary().happening, isPaused: true },
			whoActs: {
				responsibleUser: null,
				waitingParty: { id: 'party-1', organizationName: 'СПбПУ' }
			}
		});

		expect(buildTiming(paused, NOW)).toEqual({
			tone: 'neutral',
			text: 'на паузе',
			detail: 'ждём СПбПУ'
		});
	});

	it('тишина — число дней и норма стадии; без флага сервера её нет', () => {
		expect(buildQuiet(status({ isStale: false, lastActivityAt: daysAgo(30) }), NOW)).toBeNull();

		const quiet = buildQuiet(status({ isStale: true, lastActivityAt: daysAgo(23) }), NOW);

		expect(quiet?.text).toBe('Нет событий 23 дня');
		expect(quiet?.norm).toBe(21);
	});
});

describe('лента событий', () => {
	it('собирает переходы и комментарии по одному разу, новые сверху', () => {
		const passed = entry({
			id: 'entry-passed',
			stageId: 'stage-program',
			snapshot: {
				...entry().snapshot,
				key: 'program_update',
				name: 'Актуализация программы',
				position: 10
			},
			enteredAt: daysAgo(40),
			leftAt: daysAgo(25),
			outcome: 'completed',
			resultText: 'Программа согласована'
		});
		const events = buildEvents(
			source({
				status: status({ current: entry(), history: [passed] }),
				comments: [
					{
						id: 'comment-1',
						authorId: 'user-1',
						authorName: 'Зотов Илья',
						source: 'manual',
						body: 'Группа собрана',
						createdAt: daysAgo(6)
					}
				]
			})
		);

		expect(events.map((event) => event.id)).toEqual([
			'comment:comment-1',
			'entered:entry-current',
			'left:entry-passed',
			'created:interaction-1'
		]);
		expect(events.find((event) => event.id === 'left:entry-passed')?.detail).toBe(
			'Результат: Программа согласована'
		);
		expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
	});
});

describe('назначение потока и стадии с данными обучения', () => {
	const PROGRAM = { id: 'p1', code: 'DPO-01', name: 'DevOps' };
	const B2B = [{ name: 'Ведение занятий', purposes: ['students'] as const }];

	it('помечает засчитываемые назначения, только когда процесс их сужает', () => {
		expect(purposeCountingStages(B2B, 'students')).toStrictEqual(['Ведение занятий']);
		expect(purposeCountingStages(B2B, 'teachers')).toStrictEqual([]);
		expect(purposeCountingStages([{ name: 'Обучение', purposes: null }], 'teachers')).toBeNull();
		expect(purposeCountingStages([], 'teachers')).toBeNull();
	});

	it('называет настоящую причину, по которой поток стадию не подтверждает', () => {
		const exchange = { programs: [PROGRAM], learningStages: B2B };

		expect(describeUncountedGroup({ program: PROGRAM, purpose: 'teachers' }, exchange)).toBe(
			'Назначение потока «Обучение преподавателей» стадия «Ведение занятий» не засчитывает: она принимает только «Обучение студентов».'
		);
		expect(
			describeUncountedGroup(
				{ program: PROGRAM, purpose: 'students' },
				{ ...exchange, programs: [] }
			)
		).toBe('Программы потока больше нет в записи — стадию он не подтверждает.');
		expect(describeUncountedGroup({ program: null, purpose: 'students' }, exchange)).toBe(
			'Программа потока не закреплена — стадию он не подтверждает.'
		);
	});
});
