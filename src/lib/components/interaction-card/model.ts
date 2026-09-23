import { ORGANIZATION_KIND_LABELS } from '$lib/components/directory/labels';
import {
	DOCUMENT_STATUS_FACT_LABELS,
	documentKindLabel,
	type DocumentStatusFact
} from '$lib/contracts/documents';
import type { OrganizationView } from '$lib/contracts/directory';
import { EXCHANGE_STATE_LABELS, type LearningGroupView } from '$lib/contracts/exchange';
import {
	blockerReasonLabel,
	CONTRACT_STATUS_LABELS,
	PAUSE_REASON_LABELS,
	type BlockerView,
	type CommentView,
	type InteractionChangeView,
	type InteractionClosingView,
	type InteractionPartyView,
	type InteractionStatusView,
	type InteractionSummaryView,
	type InteractionView,
	type StageEntryView,
	type StageOutcome,
	type StageProgressItem
} from '$lib/contracts/interactions';
import { daysUntil, formatDate, pluralize } from '$lib/format';

/**
 * Карточка взаимодействия как набор фактов, каждый из которых назван ровно в
 * одном месте экрана.
 *
 * Серверные представления карточки (`InteractionView`, статус, сводка,
 * закрытие, обмен) отвечают каждое на свой вопрос и поэтому пересекаются:
 * просрочка есть и в статусе, и в сводке, незакрытый пункт чек-листа — и в
 * снимке стадии, и в приговоре перехода. Здесь они сводятся в одну модель, где
 * у каждого факта одно место: срок — в шапке, условия перехода — у главного
 * действия, всё случившееся — в ленте событий.
 */

/** Всё, из чего собирается карточка: ровно то, что читает загрузчик карточки. */
export type CardSource = {
	interaction: InteractionView;
	status: InteractionStatusView;
	summary: InteractionSummaryView;
	closing: InteractionClosingView;
	comments: readonly CommentView[];
	changes: readonly InteractionChangeView[];
	/** Основная сторона из справочника: вид контрагента, реквизиты, регион. */
	counterparty: OrganizationView | null;
	/** Потоки в системе обучения и почему новый поток сейчас не заявить. */
	exchange: { groups: readonly LearningGroupView[]; issue: string | null };
};

/** Какой набор панелей нужен контрагенту: вуз с договором или обучение лица. */
export type CounterpartyShape = 'institution' | 'learner';

export type TimingTone = 'danger' | 'warning' | 'neutral';

/** Срок текущей стадии — одной фразой, с тоном по тому, сколько осталось. */
export type CardTiming = {
	tone: TimingTone;
	/** «просрочено на 55 дней», «осталось 5 дней», «на паузе». */
	text: string;
	/** «срок был 29.07.2026», «до 15.10.2026», «ждём СПбПУ». */
	detail: string;
};

/** Тишина вокруг записи словами: сколько нет событий и какая норма стадии. */
export type CardQuiet = {
	days: number;
	norm: number;
	text: string;
	advice: string;
};

export type StageDot = {
	id: string;
	position: number;
	name: string;
	state: StageProgressItem['state'];
	note: string | null;
};

/** Условие шага вперёд, которое ставит стадия. */
export type Requirement = {
	key: string;
	label: string;
	done: boolean;
	/** Обязательное условие держит переход; необязательное — только напоминает. */
	required: boolean;
	/** Чем закрывают условие: отметка в списке или отдельное действие. */
	close: 'check' | 'action' | 'external';
	/** Подпись кнопки для `action` и `external`. */
	cta: string | null;
	/** Что сделать, коротко; `null` — подпись говорит сама за себя. */
	hint: string | null;
};

export type SecondaryAction = {
	key: string;
	label: string;
	allowed: boolean;
	reason: string | null;
	tone: 'default' | 'danger';
};

/**
 * Главное действие карточки. Приговор «можно или нет» выносит сервер; модель
 * раскладывает, чем его объяснить: условиями стадии, помехами или, если
 * ни то ни другое отказа не объясняет, словами самого сервера.
 */
export type CardAction =
	| {
			kind: 'forward' | 'complete' | 'resume';
			label: string;
			allowed: boolean;
			requirements: Requirement[];
			blockers: BlockerView[];
			/** Помехи, которые переходу не мешают, но открыты. */
			softBlockers: BlockerView[];
			/** Отказ сервера, не объяснённый ни условиями, ни помехами. */
			otherReasons: string[];
			pause: { reason: string; note: string; since: Date; nextAction: string | null } | null;
	  }
	| { kind: 'closed'; label: string; outcome: string | null; at: Date | null }
	| { kind: 'none'; label: string };

export type CardEventKind = 'stage' | 'comment' | 'document' | 'exchange' | 'blocker' | 'plan';

export type CardEvent = {
	id: string;
	at: Date;
	kind: CardEventKind;
	title: string;
	detail: string | null;
	author: string | null;
	tone: 'neutral' | 'success' | 'warning' | 'danger';
};

export type CardModel = {
	id: string;
	title: string;
	status: InteractionView['status'];
	workspaceName: string;
	shape: CounterpartyShape;
	counterparty: { name: string; kindLabel: string };
	stage: { name: string; position: number; total: number } | null;
	timing: CardTiming | null;
	quiet: CardQuiet | null;
	responsible: string | null;
	/** Ход сейчас не за нами: часы стадии стоят, пока ждём эту сторону. */
	waitingFor: string | null;
	contract: { number: string; status: string; validUntil: string | null } | null;
	stages: StageDot[];
	action: CardAction;
	secondary: SecondaryAction[];
	events: CardEvent[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const DAYS = ['день', 'дня', 'дней'] as const;

const OUTCOME_LABELS: Record<StageOutcome, string> = {
	completed: 'стадия пройдена',
	returned: 'возврат на стадию',
	skipped: 'стадия пропущена',
	migrated: 'перенос при изменении процесса'
};

const FIELD_LABELS: Record<string, string> = {
	title: 'Название',
	agreementPeriodStart: 'Соглашение: начало',
	agreementPeriodEnd: 'Соглашение: окончание',
	academicPeriodStart: 'Учебный период: начало',
	academicPeriodEnd: 'Учебный период: окончание',
	ownerUserId: 'Ответственный',
	parties: 'Участники',
	programs: 'Программы',
	products: 'Продукты',
	contract: 'Договор',
	contractItems: 'Позиции договора'
};

function primaryParty(interaction: InteractionView): InteractionPartyView | null {
	return interaction.parties.find((party) => party.isPrimary) ?? null;
}

/**
 * Набор панелей выбирается по роли основной стороны: учебное заведение — это
 * вуз с договором, площадками и группой студентов; всё остальное — лицо,
 * которое учится само и само платит.
 */
export function counterpartyShape(interaction: InteractionView): CounterpartyShape {
	return primaryParty(interaction)?.partyRole === 'educational_institution'
		? 'institution'
		: 'learner';
}

export function buildTiming(summary: InteractionSummaryView, now: Date): CardTiming | null {
	const { happening, whoActs } = summary;

	if (happening.isPaused) {
		return {
			tone: 'neutral',
			text: 'на паузе',
			detail:
				whoActs.waitingParty === null
					? 'часы стадии стоят'
					: `ждём ${whoActs.waitingParty.organizationName}`
		};
	}

	if (happening.dueAt === null) {
		return null;
	}

	const left = daysUntil(happening.dueAt, now);
	const due = formatDate(happening.dueAt);

	if (left < 0) {
		return {
			tone: 'danger',
			text: `просрочено на ${pluralize(-left, DAYS)}`,
			detail: `срок был ${due}`
		};
	}

	return {
		tone: left <= 3 ? 'warning' : 'neutral',
		text: left === 0 ? 'срок сегодня' : `осталось ${pluralize(left, DAYS)}`,
		detail: `до ${due}`
	};
}

/**
 * «Тишина» словами. Флаг `isStale` сервер ставит, когда событий нет дольше
 * нормы стадии; сама по себе метка ничего не объясняет, поэтому здесь она
 * превращается в число дней, норму и совет, что с этим делать.
 */
export function buildQuiet(status: InteractionStatusView, now: Date): CardQuiet | null {
	const norm = status.current?.snapshot.staleAfterDays ?? null;

	if (!status.isStale || norm === null) {
		return null;
	}

	const days = Math.floor((now.getTime() - new Date(status.lastActivityAt).getTime()) / DAY_MS);

	return {
		days,
		norm,
		text: `Нет событий ${pluralize(days, DAYS)}`,
		advice: `Для этой стадии норма — не дольше ${pluralize(norm, DAYS)} без новостей. Напомните о себе контрагенту или запишите, чего ждёте.`
	};
}

/** Условия шага вперёд с текущей стадии — из её снимка и того, что уже сделано. */
export function buildRequirements(entry: StageEntryView, groups: readonly LearningGroupView[]) {
	const { snapshot } = entry;
	const requirements: Requirement[] = snapshot.checklist.map((item) => ({
		key: `checklist:${item.key}`,
		label: item.label,
		done: entry.checklistState[item.key] === true,
		required: item.required,
		close: 'check',
		cta: null,
		hint: null
	}));

	if (snapshot.requiresResult) {
		requirements.push({
			key: 'result',
			label: 'Записан результат стадии',
			done: entry.resultText !== null && entry.resultText.trim() !== '',
			required: true,
			close: 'action',
			cta: 'Записать результат',
			hint: null
		});
	}

	if (snapshot.requiresLmsData) {
		const counted = groups.filter((group) => group.countsForStage);

		requirements.push({
			key: 'lms',
			label: 'Обучение завершено',
			done: entry.lmsEvidence !== null,
			required: true,
			close: 'external',
			cta: 'Отметить завершение',
			hint:
				counted.length === 0
					? 'Сначала заявите поток в систему обучения — итог придёт оттуда.'
					: 'Итог придёт из системы обучения сам. Если данных не будет, отметьте завершение с объяснением.'
		});
	}

	if (snapshot.requiresConfirmation) {
		requirements.push({
			key: 'confirmation',
			label: 'Стадия подтверждена',
			done: entry.confirmation !== null,
			required: true,
			close: 'action',
			cta: 'Подтвердить',
			hint: 'Файлом, отметкой ответственного или записью системы обучения.'
		});
	}

	const mark: DocumentStatusFact | null = snapshot.requiresDocumentMark;

	if (mark !== null) {
		requirements.push({
			key: 'document-mark',
			label: `Документ с отметкой «${DOCUMENT_STATUS_FACT_LABELS[mark]}»`,
			done: entry.documentMarkEvidence?.mark === mark,
			required: true,
			close: 'action',
			cta: 'Отметить документ',
			hint: null
		});
	}

	return requirements;
}

function buildAction(source: CardSource): CardAction {
	const { interaction, status, summary, closing, exchange } = source;

	if (interaction.status !== 'active') {
		const last = status.history[0] ?? null;

		return {
			kind: 'closed',
			label:
				interaction.status === 'completed' ? 'Взаимодействие завершено' : 'Взаимодействие отменено',
			outcome: last?.outcomeReason ?? null,
			at: last?.leftAt ?? null
		};
	}

	const entry = status.current;

	if (entry === null) {
		return { kind: 'none', label: 'Запись не стоит ни на одной стадии' };
	}

	const requirements = buildRequirements(entry, exchange.groups);
	const blockers = summary.blocking.blockers.filter((blocker) => blocker.blocksTransition);
	const softBlockers = summary.blocking.blockers.filter((blocker) => !blocker.blocksTransition);
	const pause =
		summary.happening.pause === null
			? null
			: {
					reason: PAUSE_REASON_LABELS[summary.happening.pause.reason],
					note: summary.happening.pause.note,
					since: summary.happening.pause.startedAt,
					nextAction: summary.happening.pause.nextAction
				};

	/**
	 * Отказ, который модели нечем объяснить, показывается словами сервера:
	 * недостаток прав или устаревшая редакция процесса — не условие стадии, и
	 * молча выключенная кнопка была бы хуже повтора.
	 */
	const explained = (allowed: boolean) =>
		allowed ||
		entry.isPaused ||
		blockers.length > 0 ||
		requirements.some((item) => item.required && !item.done);

	if (entry.isPaused) {
		const allowed = summary.canDo.actions.includes('resume');

		return {
			kind: 'resume',
			label: 'Снять паузу',
			allowed,
			requirements,
			blockers,
			softBlockers,
			otherReasons: allowed ? [] : ['Нет права снимать паузу'],
			pause
		};
	}

	const forward = summary.canDo.transitions.filter(
		(option) => option.transition.kind === 'forward'
	);
	const chosen = forward.find((option) => option.allowed) ?? forward[0] ?? null;

	if (chosen !== null) {
		return {
			kind: 'forward',
			label: `Перейти к «${chosen.toStage.name}»`,
			allowed: chosen.allowed,
			requirements,
			blockers,
			softBlockers,
			otherReasons: explained(chosen.allowed) ? [] : chosen.reasons,
			pause
		};
	}

	return {
		kind: 'complete',
		label: 'Завершить взаимодействие',
		allowed: closing.complete.allowed,
		requirements,
		blockers,
		softBlockers,
		otherReasons: explained(closing.complete.allowed) ? [] : closing.complete.reasons,
		pause
	};
}

function buildSecondary(source: CardSource): SecondaryAction[] {
	const { summary, closing, interaction } = source;

	if (interaction.status !== 'active') {
		return [];
	}

	const can = (action: string) => summary.canDo.actions.includes(action as 'pause');
	const result: SecondaryAction[] = summary.canDo.transitions
		.filter((option) => option.transition.kind !== 'forward')
		.map((option) => ({
			key: option.transition.id,
			label:
				option.transition.kind === 'return'
					? `Вернуть на «${option.toStage.name}»`
					: `Пропустить до «${option.toStage.name}»`,
			allowed: option.allowed,
			reason: option.allowed ? null : option.reasons.join('; '),
			tone: 'default'
		}));

	if (can('pause')) {
		result.push({
			key: 'pause',
			label: 'Поставить на паузу',
			allowed: true,
			reason: null,
			tone: 'default'
		});
	}

	result.push({
		key: 'blocker',
		label: 'Сообщить о помехе',
		allowed: can('raise_blocker'),
		reason: can('raise_blocker') ? null : 'Нет права поднимать помехи',
		tone: 'default'
	});

	result.push({
		key: 'responsible',
		label: 'Передать другому сотруднику',
		allowed: can('set_responsible'),
		reason: can('set_responsible') ? null : 'Нет права менять ответственного',
		tone: 'default'
	});

	if (closing.complete.requiresForce) {
		result.push({
			key: 'complete-early',
			label: 'Завершить досрочно',
			allowed: closing.complete.allowed,
			reason: closing.complete.allowed ? null : closing.complete.reasons.join('; '),
			tone: 'default'
		});
	}

	result.push({
		key: 'cancel',
		label: 'Отменить взаимодействие',
		allowed: closing.cancel.allowed,
		reason: closing.cancel.allowed ? null : closing.cancel.reasons.join('; '),
		tone: 'danger'
	});

	return result;
}

function describeChange(label: string | null, value: unknown): string {
	if (label !== null) return label;
	if (value === null || value === undefined) return '—';

	return typeof value === 'string' ? value : JSON.stringify(value);
}

const stageTitle = (entry: StageEntryView) => `${entry.snapshot.position}. ${entry.snapshot.name}`;

/**
 * Единая лента: переходы, паузы, подтверждения, комментарии, документы,
 * правки плана, помехи и обмен с системой обучения — одним списком по времени,
 * новые сверху. Каждое событие попадает в ленту один раз и только сюда.
 */
export function buildEvents(source: CardSource): CardEvent[] {
	const { interaction, status, comments, changes, exchange } = source;
	const events: CardEvent[] = [];
	const entries = status.current === null ? status.history : [status.current, ...status.history];
	const oldest = entries.at(-1) ?? null;

	for (const entry of entries) {
		if (entry === oldest) {
			events.push({
				id: `created:${interaction.id}`,
				at: entry.enteredAt,
				kind: 'stage',
				title: `Запись заведена на стадии «${stageTitle(entry)}»`,
				detail: null,
				author: null,
				tone: 'neutral'
			});
		}

		if (entry.leftAt !== null && entry.outcome !== null) {
			const detail = [
				entry.outcomeReason,
				entry.resultText === null ? null : `Результат: ${entry.resultText}`,
				entry.documents.length === 0
					? null
					: `Вложения: ${entry.documents.map((document) => document.title).join(', ')}`
			].filter((part): part is string => part !== null && part !== '');

			events.push({
				id: `left:${entry.id}`,
				at: entry.leftAt,
				kind: 'stage',
				title: `«${stageTitle(entry)}» — ${OUTCOME_LABELS[entry.outcome]}`,
				detail: detail.length === 0 ? null : detail.join(' · '),
				author: entry.responsibleName,
				tone: entry.outcome === 'completed' ? 'success' : 'warning'
			});
		} else if (entry !== oldest) {
			events.push({
				id: `entered:${entry.id}`,
				at: entry.enteredAt,
				kind: 'stage',
				title: `Начата стадия «${stageTitle(entry)}»`,
				detail: null,
				author: null,
				tone: 'neutral'
			});
		}

		if (entry.confirmedAt !== null && entry.confirmation !== null) {
			events.push({
				id: `confirmed:${entry.id}`,
				at: entry.confirmedAt,
				kind: 'stage',
				title: `«${stageTitle(entry)}» подтверждена`,
				detail: CONFIRMATION_LABELS[entry.confirmation.kind],
				author: null,
				tone: 'success'
			});
		}

		for (const pause of entry.pauses) {
			events.push({
				id: `pause:${pause.id}`,
				at: pause.startedAt,
				kind: 'stage',
				title: `Пауза: ${PAUSE_REASON_LABELS[pause.reason].toLowerCase()}`,
				detail: [pause.note, pause.nextAction ? `Следующий шаг: ${pause.nextAction}` : null]
					.filter((part): part is string => part !== null)
					.join(' · '),
				author: null,
				tone: 'neutral'
			});

			if (pause.endedAt !== null) {
				events.push({
					id: `resume:${pause.id}`,
					at: pause.endedAt,
					kind: 'stage',
					title: 'Пауза снята',
					detail: null,
					author: null,
					tone: 'neutral'
				});
			}
		}
	}

	for (const comment of comments) {
		events.push({
			id: `comment:${comment.id}`,
			at: comment.createdAt,
			kind: 'comment',
			title: 'Комментарий',
			detail: comment.body,
			author: comment.authorName,
			tone: 'neutral'
		});
	}

	for (const document of interaction.documents) {
		events.push({
			id: `document:${document.id}`,
			at: document.createdAt,
			kind: 'document',
			title: `Добавлен документ «${document.title}»`,
			detail: documentKindLabel(document.kind),
			author: null,
			tone: 'neutral'
		});

		const marks: [DocumentStatusFact, Date | null, string | null][] = [
			['agreed', document.agreedAt, document.agreedNote],
			['approved', document.approvedAt, document.approvedNote],
			['in_effect', document.inEffectAt, document.inEffectNote]
		];

		for (const [fact, at, note] of marks) {
			if (at !== null) {
				events.push({
					id: `document:${document.id}:${fact}`,
					at,
					kind: 'document',
					title: `«${document.title}»: ${DOCUMENT_STATUS_FACT_LABELS[fact].toLowerCase()}`,
					detail: note,
					author: null,
					tone: 'success'
				});
			}
		}
	}

	for (const change of changes) {
		events.push({
			id: `change:${change.id}`,
			at: change.changedAt,
			kind: 'plan',
			title: `${FIELD_LABELS[change.field] ?? change.field}: ${describeChange(change.oldLabel, change.oldValue)} → ${describeChange(change.newLabel, change.newValue)}`,
			detail: change.reason,
			author: change.authorName,
			tone: 'neutral'
		});
	}

	for (const blocker of status.blockers) {
		events.push({
			id: `blocker:${blocker.id}`,
			at: blocker.raisedAt,
			kind: 'blocker',
			title: `Помеха: ${blockerReasonLabel(blocker.reasonCode).toLowerCase()}`,
			detail: blocker.description,
			author: blocker.raisedByName,
			tone: blocker.blocksTransition ? 'danger' : 'warning'
		});

		if (blocker.resolvedAt !== null) {
			events.push({
				id: `blocker-resolved:${blocker.id}`,
				at: blocker.resolvedAt,
				kind: 'blocker',
				title: 'Помеха снята',
				detail: blocker.resolution,
				author: null,
				tone: 'success'
			});
		}
	}

	for (const group of exchange.groups) {
		events.push({
			id: `group:${group.id}`,
			at: group.requestedAt,
			kind: 'exchange',
			title: `Заявка на поток ${group.streamNumber} в систему обучения`,
			detail:
				group.messageState === null
					? null
					: `${EXCHANGE_STATE_LABELS[group.messageState]}${group.groupExternalId ? ` · группа ${group.groupExternalId}` : ''}`,
			author: null,
			tone: group.messageState === 'failed' ? 'danger' : 'neutral'
		});

		if (group.lastResultAt !== null && group.enrolled !== null) {
			events.push({
				id: `group-result:${group.id}`,
				at: group.lastResultAt,
				kind: 'exchange',
				title: `Результат по потоку ${group.streamNumber} из системы обучения`,
				detail: `зачислено ${group.enrolled}, завершили ${group.completed ?? 0}, отчислено ${group.expelled ?? 0}${group.finishedOn ? ` · окончание ${formatDate(group.finishedOn)}` : ''}`,
				author: null,
				tone: group.trainingState === 'completed' ? 'success' : 'neutral'
			});
		}

		if (group.completionMark !== null) {
			events.push({
				id: `group-mark:${group.id}`,
				at: group.completionMark.at,
				kind: 'exchange',
				title: `Поток ${group.streamNumber}: обучение отмечено завершённым`,
				detail: group.completionMark.comment,
				author: group.completionMark.byName,
				tone: 'success'
			});
		}
	}

	return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

const CONFIRMATION_LABELS: Record<NonNullable<StageEntryView['confirmation']>['kind'], string> = {
	file: 'приложенным файлом',
	mark: 'отметкой ответственного',
	lms_record: 'записью системы обучения',
	document_mark: 'отметкой по документу'
};

export function buildCard(source: CardSource, now: Date): CardModel {
	const { interaction, status, summary } = source;
	const primary = primaryParty(interaction);
	const stage = summary.happening.stage;

	return {
		id: interaction.id,
		title: interaction.title,
		status: interaction.status,
		workspaceName: interaction.workspaceName,
		shape: counterpartyShape(interaction),
		counterparty: {
			name: source.counterparty?.shortName ?? primary?.organizationName ?? 'Контрагент не указан',
			kindLabel:
				source.counterparty === null ? '' : ORGANIZATION_KIND_LABELS[source.counterparty.kind]
		},
		stage:
			stage === null
				? null
				: { name: stage.name, position: stage.position, total: status.progress.length },
		timing: interaction.status === 'active' ? buildTiming(summary, now) : null,
		quiet: interaction.status === 'active' ? buildQuiet(status, now) : null,
		responsible: summary.whoActs.responsibleUser?.name ?? null,
		waitingFor: summary.whoActs.waitingParty?.organizationName ?? null,
		contract:
			interaction.contract === null
				? null
				: {
						number: interaction.contract.number,
						status: CONTRACT_STATUS_LABELS[interaction.contract.status],
						validUntil: interaction.contract.validUntil
					},
		stages: status.progress.map((item) => ({
			id: item.stageId,
			position: item.position,
			name: item.name,
			state: item.state,
			note: item.note
		})),
		action: buildAction(source),
		secondary: buildSecondary(source),
		events: buildEvents(source)
	};
}
