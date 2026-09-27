import { ORGANIZATION_KIND_LABELS } from '$lib/components/directory/labels';
import {
	DOCUMENT_STATUS_FACT_LABELS,
	DOCUMENT_TEMPLATE_LABELS,
	documentKindLabel,
	type DocumentStatusFact,
	type DocumentTemplateKey
} from '$lib/contracts/documents';
import type { OrganizationKind, OrganizationView } from '$lib/contracts/directory';
import {
	EXCHANGE_STATE_LABELS,
	LEARNING_PURPOSE_LABELS,
	lmsEvidenceSchema,
	type LearningGroupLearnerView,
	type LearningGroupView,
	type LearningPurpose
} from '$lib/contracts/exchange';
import {
	blockerReasonLabel,
	CONTRACT_STATUS_LABELS,
	PAUSE_REASON_LABELS,
	type BlockerView,
	type CommentView,
	type InteractionAction,
	type InteractionChangeView,
	type InteractionClosingView,
	type InteractionPartyView,
	type InteractionStatusView,
	type InteractionSummaryView,
	type InteractionView,
	type StageConfirmation,
	type StageEntryView,
	type StageOutcome,
	type StageProgressItem,
	type StageTransitionKind
} from '$lib/contracts/interactions';
import { PAYMENT_CHECKLIST_KEY, type PaymentFactView } from '$lib/contracts/payments';
import type { ProcessCard } from '$lib/contracts/process-card';
import { daysUntil, formatDate, formatDateTime, pluralize } from '$lib/format';
import { cardActionSpecs, visiblePanels, type ModuleKey } from '$lib/platform/registry';

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

/** Программа или продукт взаимодействия в форме заявки на поток. */
export type CardOffering = { id: string; code: string; name: string };

/**
 * Стадия процесса, которой нужны данные обучения, и назначения групп, которые
 * она засчитывает; `purposes: null` — любые.
 */
export type CardLearningStage = {
	name: string;
	purposes: readonly LearningPurpose[] | null;
};

/**
 * Обмен с системой обучения в том виде, в каком его отдаёт загрузчик карточки:
 * заведённые потоки, из чего собирается заявка на новый и можно ли её подать.
 */
export type CardExchange = {
	groups: readonly LearningGroupView[];
	nextStreamNumber: number;
	programs: readonly CardOffering[];
	products: readonly CardOffering[];
	canSend: boolean;
	/** Можно ли отметить обучение завершённым без итога из системы обучения. */
	canComplete: boolean;
	/** Можно ли загружать и править поимённые списки слушателей. */
	canManageRoster: boolean;
	/** Можно ли выгрузить список потока файлом для системы обучения: нужны люди и контакты. */
	canExportRoster: boolean;
	/** Сколько слушателей потока отозвали согласие и не выгрузятся: поток → число. */
	withdrawnLearners: Readonly<Record<string, number>>;
	/** Почему новый поток сейчас не заявить; `null` — можно. */
	issue: string | null;
	/**
	 * Стадии процесса, которым нужны данные обучения, в порядке маршрута. По ним
	 * форма заявки помечает назначения, а карточка объясняет, почему поток
	 * стадию не подтверждает. Пусто — таких стадий нет.
	 */
	learningStages: readonly CardLearningStage[];
	/** Слушатели всех потоков; `null` — люди не видны, карточка показывает только числа. */
	learners: readonly LearningGroupLearnerView[] | null;
};

/** Всё, из чего собирается карточка: ровно то, что читает загрузчик карточки. */
/** Названия стадий через запятую, каждое в кавычках. */
const stageNames = (stages: readonly CardLearningStage[]) =>
	stages.map((stage) => `«${stage.name}»`).join(', ');

/**
 * Какие стадии засчитают поток этого назначения. Назначения сравниваются только
 * там, где процесс их сужает: если ни одна стадия назначений не называет,
 * засчитывает любое, и помечать нечего — `null`.
 */
export function purposeCountingStages(
	stages: readonly CardLearningStage[],
	purpose: LearningPurpose
): string[] | null {
	if (!stages.some((stage) => stage.purposes !== null)) {
		return null;
	}

	return stages
		.filter((stage) => stage.purposes === null || stage.purposes.includes(purpose))
		.map((stage) => stage.name);
}

/**
 * Почему поток не подтверждает стадию — по фактической причине, в порядке
 * правила нужной группы (`evidence.ts`): сначала программа, потом назначение.
 */
export function describeUncountedGroup(
	group: Pick<LearningGroupView, 'program' | 'purpose'>,
	exchange: Pick<CardExchange, 'programs' | 'learningStages'>
): string {
	if (group.program === null) {
		return 'Программа потока не закреплена — стадию он не подтверждает.';
	}

	const programId = group.program.id;

	if (!exchange.programs.some((program) => program.id === programId)) {
		return 'Программы потока больше нет в записи — стадию он не подтверждает.';
	}

	const purpose = group.purpose;
	const refusing = exchange.learningStages.filter(
		(stage) => stage.purposes !== null && (purpose === null || !stage.purposes.includes(purpose))
	);

	if (refusing.length === 0) {
		// Программа на месте, назначение засчитывается: значит, данные карточки
		// прочитаны не одновременно — причину назвать нечем.
		return 'Стадию поток не подтверждает.';
	}

	const allowed = [...new Set(refusing.flatMap((stage) => stage.purposes ?? []))]
		.map((value) => `«${LEARNING_PURPOSE_LABELS[value]}»`)
		.join(' или ');

	const one = refusing.length === 1;
	const subject = `${one ? 'стадия' : 'стадии'} ${stageNames(refusing)}`;

	return purpose === null
		? `Назначение потока не указано, а ${subject} ${one ? 'засчитывает' : 'засчитывают'} только ${allowed} — стадию он не подтверждает.`
		: `Назначение потока «${LEARNING_PURPOSE_LABELS[purpose]}» ${subject} не ${one ? 'засчитывает' : 'засчитывают'}: ${one ? 'она принимает' : 'они принимают'} только ${allowed}.`;
}

export type CardSource = {
	interaction: InteractionView;
	status: InteractionStatusView;
	summary: InteractionSummaryView;
	closing: InteractionClosingView;
	comments: readonly CommentView[];
	changes: readonly InteractionChangeView[];
	/** Основная сторона из справочника: вид контрагента, реквизиты, регион. */
	counterparty: OrganizationView | null;
	exchange: CardExchange;
	/** Факт оплаты с сайта из загруженной выгрузки; `null` — его нет. */
	paymentFact: PaymentFactView | null;
	/**
	 * Состав карточки из процесса записи и вид основной стороны. Вид читается
	 * отдельно от справочника: реквизиты закрыты правом, а какую карточку
	 * рисовать, нужно знать любому, кто запись видит.
	 */
	card: ProcessCard & { counterpartyKind: OrganizationKind };
	/**
	 * Модули, действующие в пространстве записи: включённые или нужные стадиям
	 * его процесса. Панели и факты шапки выключенного модуля карточка не рисует,
	 * даже если процесс их выбрал.
	 */
	modules: readonly ModuleKey[];
};

/**
 * Команда карточки, которую человек начинает кнопкой: почти каждая открывает
 * свой диалог с формой. Модель называет команду, а какой диалог её спросит,
 * решает раскладка, — так пункт меню, кнопка у условия и кнопка в панели
 * контекста ведут в одну и ту же форму.
 */
export type CardCommand =
	| {
			kind: 'transition';
			transition: StageTransitionKind;
			toStageId: string;
			name: string;
			requiresReason: boolean;
	  }
	| { kind: 'pause' }
	| { kind: 'result' }
	| { kind: 'confirm' }
	| { kind: 'raise-blocker' }
	| { kind: 'resolve-blocker'; blockerId: string; description: string }
	| { kind: 'assign' }
	| { kind: 'complete' }
	| { kind: 'cancel' }
	| { kind: 'plan' }
	| { kind: 'contract' }
	| { kind: 'upload' }
	| { kind: 'revision'; documentId: string }
	| { kind: 'mark'; documentId: string | null; fact: DocumentStatusFact | null }
	| {
			kind: 'package';
			/** Шаблоны пакета дела: объявлены процессом и подходят контрагенту. */
			templates: DocumentTemplateKey[];
			counterpartyKind: OrganizationKind;
	  }
	| { kind: 'send-group' }
	| { kind: 'complete-group'; groupId: string | null }
	| { kind: 'roster'; groupId: string }
	/**
	 * Действие карточки, которое принёс модуль (`cardActions` манифеста): диалог
	 * к нему рисует сам модуль, и узнаёт свою команду по ключам модуля и действия.
	 */
	| { kind: 'module'; module: ModuleKey; action: string };

/**
 * Вид контрагента, от которого зависят шапка и условия: вуз работает по
 * договору с продуктами и лицензиями, физическое лицо учится само и само
 * платит, юридическое лицо отправляет на обучение своих людей по договору.
 * Какие ещё панели стоят в карточке, решает процесс, а не вид.
 */
export type CounterpartyShape = 'institution' | 'person' | 'company';

/**
 * Оплата словами. Отдельного поля оплаты у записи нет: её отмечают пунктом
 * чек-листа `payment_received` на той стадии процесса, где он объявлен, и
 * модель читает его оттуда.
 */
export type CardPayment = {
	tone: 'neutral' | 'info' | 'success' | 'warning';
	text: string;
	/** На какой стадии отмечается; `null` — такой отметки в пройденном нет. */
	stageName: string | null;
	/** Откуда оплата: строка о загруженной оплате с сайта; `null` — её не загружали. */
	site: string | null;
};

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
	/** Ключ пункта чек-листа, который отмечается формой; только у `check`. */
	checklistKey: string | null;
	/** Подпись кнопки для `action` и `external`. */
	cta: string | null;
	/** Что начинает кнопка; `null` — кнопки нет, условие закроется само. */
	command: CardCommand | null;
	/** Что сделать, коротко; `null` — подпись говорит сама за себя. */
	hint: string | null;
	/** Чем условие выполнено — у сделанного: результат, чем подтверждено. */
	doneNote: string | null;
};

export type SecondaryAction = {
	key: string;
	label: string;
	allowed: boolean;
	reason: string | null;
	tone: 'default' | 'danger';
	command: CardCommand;
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
			/**
			 * Запись стадии, к которой относятся отметки чек-листа и снятие паузы:
			 * сервер откажет, если к моменту отправки открыта уже другая.
			 */
			stageEntryId: string;
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
	/** Сколько запись простояла на стадии — у события «стадия закрыта». */
	duration: string | null;
	tone: 'neutral' | 'success' | 'warning' | 'danger';
};

export type CardModel = {
	id: string;
	title: string;
	status: InteractionView['status'];
	workspaceName: string;
	shape: CounterpartyShape;
	counterparty: { name: string; kindLabel: string };
	/** Действующие модули пространства: из них карточка берёт панели и факты шапки. */
	modules: readonly ModuleKey[];
	/**
	 * Панели процесса в порядке каталога — только ядра и действующих модулей;
	 * сторона стоит всегда и в набор не входит.
	 */
	panels: ProcessCard['panels'];
	payment: CardPayment;
	stage: { name: string; position: number; total: number } | null;
	timing: CardTiming | null;
	quiet: CardQuiet | null;
	responsible: string | null;
	/** Ход сейчас не за нами: часы стадии стоят, пока ждём эту сторону. */
	waitingFor: string | null;
	contract: { number: string; status: string; validUntil: string | null } | null;
	stages: StageDot[];
	action: CardAction;
	/** Что начинает главная кнопка; `null` — отправка без диалога или кнопки нет. */
	primary: CardCommand | null;
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

/** Вид контрагента по виду основной стороны в справочнике. */
function counterpartyShape(kind: OrganizationKind): CounterpartyShape {
	if (kind === 'educational_institution') return 'institution';

	return kind === 'individual' ? 'person' : 'company';
}

/**
 * Оплата по записям стадий, новые первыми: ищется последняя стадия, в чек-листе
 * которой объявлена отметка об оплате. Пока стадия открыта, отметка — условие
 * перехода, и названа она у главного действия; здесь — только где её ставят.
 *
 * Оплата с сайта уже загружена, а стадия с отметкой ещё впереди — это не «не
 * отмечена»: деньги пришли, и отметку поставит вход на стадию по этому факту.
 */
export function buildPayment(
	entries: readonly StageEntryView[],
	fact: PaymentFactView | null
): CardPayment {
	const site =
		fact === null
			? null
			: [
					`Оплата с сайта: заявка ${fact.orderId}`,
					...(fact.streamNumber === null ? [] : [`поток ${fact.streamNumber}`]),
					`загружено ${formatDate(fact.loadedAt)}`
				].join(', ');
	const entry = entries.find((candidate) =>
		candidate.snapshot.checklist.some((item) => item.key === PAYMENT_CHECKLIST_KEY)
	);

	if (entry === undefined) {
		if (fact !== null) {
			return {
				tone: 'info',
				text:
					fact.stageName === null
						? 'Оплачено на сайте'
						: `Оплачено на сайте — отметится на стадии «${fact.stageName}»`,
				stageName: null,
				site
			};
		}

		return { tone: 'neutral', text: 'Не отмечена', stageName: null, site };
	}

	const stageName = entry.snapshot.name;

	if (entry.checklistState[PAYMENT_CHECKLIST_KEY] === true) {
		return { tone: 'success', text: 'Оплата получена', stageName, site };
	}

	return entry.leftAt === null
		? { tone: 'neutral', text: 'Отмечается на текущей стадии', stageName, site }
		: { tone: 'warning', text: 'Ждём оплату', stageName, site };
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

const CONFIRMATION_LABELS: Record<StageConfirmation['kind'], string> = {
	file: 'приложенным файлом',
	mark: 'отметкой ответственного',
	lms_record: 'записью в системе обучения',
	document_mark: 'отметкой по документу'
};

/** Чем подтверждена стадия, словами: способ, источник и когда. */
function describeConfirmation(entry: StageEntryView): string | null {
	const { confirmation } = entry;

	if (confirmation === null) {
		return null;
	}

	const how =
		confirmation.kind === 'lms_record'
			? `${CONFIRMATION_LABELS.lms_record} (${confirmation.source})`
			: confirmation.kind === 'document_mark'
				? `отметкой «${DOCUMENT_STATUS_FACT_LABELS[confirmation.mark]}» по документу`
				: CONFIRMATION_LABELS[confirmation.kind];

	return `Подтверждено ${how}${entry.confirmedAt === null ? '' : `, ${formatDateTime(entry.confirmedAt)}`}`;
}

/** Факт завершения обучения словами; `null` — обучение не завершено. */
function describeLmsEvidence(entry: StageEntryView): string | null {
	const evidence = lmsEvidenceSchema.safeParse(entry.lmsEvidence).data ?? null;

	if (evidence === null) {
		return null;
	}

	if (evidence.kind === 'result') {
		return `Итог группы ${evidence.groupExternalId}: зачислено ${evidence.enrolled}, завершили ${evidence.completed}, отчислены ${evidence.expelled}${evidence.finishedOn === null ? '' : `, окончание ${formatDate(evidence.finishedOn)}`}`;
	}

	return `Отмечено сотрудником по потоку ${evidence.streamNumber} ${formatDateTime(evidence.markedAt)}: «${evidence.comment}»`;
}

/**
 * Условия шага вперёд с текущей стадии — из её снимка и того, что уже сделано.
 *
 * Подтверждение попадает в список и там, где стадия его не требует, если оно
 * уже есть: чем подтверждена стадия — факт о ней, и спрятать его только
 * потому, что процесс его не просил, значило бы потерять.
 *
 * `modules` — действующие модули пространства: пункт чек-листа, к которому
 * модуль привязал своё действие (`checklistItems`), держит кнопку этого
 * действия прямо у себя — на любой стадии, где такой пункт есть.
 */
export function buildRequirements(
	entry: StageEntryView,
	exchange: CardExchange,
	modules: readonly string[]
): Requirement[] {
	const { snapshot } = entry;
	const moduleActions = cardActionSpecs(modules);
	const requirements: Requirement[] = snapshot.checklist.map((item) => {
		// Пункт, закрытый действием модуля, — первым по порядку конфига: два
		// модуля на одном пункте дали бы две кнопки там, где место под одну.
		const action = moduleActions.find((spec) => spec.checklistItems.includes(item.key));

		return {
			key: `checklist:${item.key}`,
			label: item.label,
			done: entry.checklistState[item.key] === true,
			required: item.required,
			close: 'check',
			checklistKey: item.key,
			cta: action?.label ?? null,
			command:
				action === undefined ? null : { kind: 'module', module: action.module, action: action.key },
			hint: action?.checklistHint ?? null,
			doneNote: null
		};
	});

	if (snapshot.requiresResult) {
		const done = entry.resultText !== null && entry.resultText.trim() !== '';

		requirements.push({
			key: 'result',
			label: 'Записан результат стадии',
			done,
			required: true,
			close: 'action',
			checklistKey: null,
			cta: 'Записать результат',
			command: { kind: 'result' },
			hint: null,
			doneNote: done ? entry.resultText : null
		});
	}

	if (snapshot.requiresLmsData) {
		const counted = exchange.groups.filter((group) => group.countsForStage);
		const unfinished = counted.filter((group) => group.trainingState !== 'completed');
		const noStream = counted.length === 0;
		const canMark = !noStream && exchange.canComplete && unfinished.length > 0;
		const purposes = snapshot.lmsGroupPurposes;
		const purposeHint =
			purposes === null
				? ''
				: ` Засчитывается только группа с назначением ${purposes
						.map((purpose) => `«${LEARNING_PURPOSE_LABELS[purpose]}»`)
						.join(' или ')}.`;

		requirements.push({
			key: 'lms',
			label: 'Обучение завершено',
			done: entry.lmsEvidence !== null,
			required: true,
			close: 'external',
			checklistKey: null,
			cta: noStream ? 'Заявить поток' : canMark ? 'Отметить завершение' : null,
			command: noStream
				? { kind: 'send-group' }
				: canMark
					? { kind: 'complete-group', groupId: unfinished.length === 1 ? unfinished[0].id : null }
					: null,
			hint: noStream
				? `Сначала заявите поток в систему обучения — итог придёт оттуда.${purposeHint}`
				: `Итог придёт из системы обучения сам. Если данных не будет, отметьте завершение с объяснением.${purposeHint}`,
			doneNote: describeLmsEvidence(entry)
		});
	}

	if (snapshot.requiresConfirmation || entry.confirmation !== null) {
		requirements.push({
			key: 'confirmation',
			label: 'Стадия подтверждена',
			done: entry.confirmation !== null,
			required: snapshot.requiresConfirmation,
			close: 'action',
			checklistKey: null,
			cta: 'Подтвердить',
			command: { kind: 'confirm' },
			hint: 'Файлом, отметкой ответственного или записью системы обучения.',
			doneNote: describeConfirmation(entry)
		});
	}

	const mark: DocumentStatusFact | null = snapshot.requiresDocumentMark;

	if (mark !== null) {
		const evidence = entry.documentMarkEvidence?.mark === mark ? entry.documentMarkEvidence : null;
		const template = snapshot.requiresDocumentTemplate;

		requirements.push({
			key: 'document-mark',
			label:
				template === null
					? `Документ с отметкой «${DOCUMENT_STATUS_FACT_LABELS[mark]}»`
					: `«${DOCUMENT_TEMPLATE_LABELS[template]}» с отметкой «${DOCUMENT_STATUS_FACT_LABELS[mark]}»`,
			done: evidence !== null,
			required: true,
			close: 'action',
			checklistKey: null,
			cta: 'Отметить документ',
			command: { kind: 'mark', documentId: null, fact: mark },
			hint: 'Стадию закрывает отметка по самому документу, а не отметка ответственного.',
			doneNote: evidence === null ? null : `«${evidence.title}» от ${formatDate(evidence.markedAt)}`
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

	const requirements = buildRequirements(entry, exchange, source.modules);
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
			stageEntryId: entry.id,
			requirements,
			blockers,
			softBlockers,
			otherReasons: allowed ? [] : ['Нет права снимать паузу'],
			pause
		};
	}

	const chosen = primaryForward(summary);

	if (chosen !== null) {
		return {
			kind: 'forward',
			label: `Перейти к «${chosen.toStage.name}»`,
			allowed: chosen.allowed,
			stageEntryId: entry.id,
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
		stageEntryId: entry.id,
		requirements,
		blockers,
		softBlockers,
		otherReasons: explained(closing.complete.allowed) ? [] : closing.complete.reasons,
		pause
	};
}

/**
 * Шаг вперёд, который карточка ставит главной кнопкой: первый доступный, а
 * если доступного нет — первый по процессу, чтобы было что объяснить.
 */
function primaryForward(summary: InteractionSummaryView) {
	const forward = summary.canDo.transitions.filter(
		(option) => option.transition.kind === 'forward'
	);

	return forward.find((option) => option.allowed) ?? forward[0] ?? null;
}

/** Переход как команда: какой диалог его спросит и что в диалог передать. */
function transitionCommand(option: InteractionSummaryView['canDo']['transitions'][number]) {
	return {
		kind: 'transition',
		transition: option.transition.kind,
		toStageId: option.toStage.id,
		name: option.toStage.name,
		requiresReason: option.transition.requiresReason
	} as const satisfies CardCommand;
}

/**
 * Команда главной кнопки. Снятие паузы — не диалог, а отправка формы, поэтому
 * у него команды нет.
 */
function primaryCommand(source: CardSource, action: CardAction): CardCommand | null {
	if (action.kind === 'forward') {
		const chosen = primaryForward(source.summary);

		return chosen === null ? null : transitionCommand(chosen);
	}

	return action.kind === 'complete' ? { kind: 'complete' } : null;
}

const TRANSITION_VERBS: Record<StageTransitionKind, string> = {
	forward: 'Перейти к',
	return: 'Вернуть на',
	skip: 'Пропустить до'
};

/**
 * Команды меню «Ещё»: всё, что можно сделать со стадией и записью, кроме
 * главного действия. Недоступное остаётся в меню с причиной — пропавший пункт
 * не объясняет ничего.
 */
function buildSecondary(source: CardSource, action: CardAction): SecondaryAction[] {
	const { summary, closing, interaction, status } = source;
	const entry = status.current;

	if (interaction.status !== 'active' || entry === null) {
		return [];
	}

	const can = (name: InteractionAction) => summary.canDo.actions.includes(name);
	const primary = action.kind === 'forward' ? primaryForward(summary) : null;
	const openRequirement = (key: string) =>
		action.kind !== 'closed' &&
		action.kind !== 'none' &&
		action.requirements.some((item) => item.key === key && item.required && !item.done);

	const result: SecondaryAction[] = summary.canDo.transitions
		.filter((option) => option !== primary)
		.map((option) => ({
			key: option.transition.id,
			label: `${TRANSITION_VERBS[option.transition.kind]} «${option.toStage.name}»`,
			allowed: option.allowed,
			reason: option.allowed ? null : option.reasons.join('; '),
			tone: 'default',
			command: transitionCommand(option)
		}));

	if (can('pause')) {
		result.push({
			key: 'pause',
			label: 'Поставить на паузу',
			allowed: true,
			reason: null,
			tone: 'default',
			command: { kind: 'pause' }
		});
	}

	// Действия действующих модулей стоят в меню на любой стадии, а у пункта
	// чек-листа, к которому модуль их привязал, дублируются кнопкой (см.
	// `buildRequirements`). Право модуль называет сам (`requires`) — действием
	// из приговора сервера, как у пунктов ядра.
	for (const spec of cardActionSpecs(source.modules)) {
		if (!spec.menu) continue;

		const allowed = spec.requires === null || can(spec.requires);

		result.push({
			key: `module:${spec.module}:${spec.key}`,
			label: spec.label,
			allowed,
			reason: allowed ? null : spec.deniedReason,
			tone: 'default',
			command: { kind: 'module', module: spec.module, action: spec.key }
		});
	}

	// Результат и подтверждение, которых стадия не требует (или которые уже
	// есть), живут в меню: условием перехода они не стоят, а записать или
	// поправить их можно всегда.
	if (!openRequirement('result')) {
		result.push({
			key: 'result',
			label: entry.resultText === null ? 'Записать результат стадии' : 'Изменить результат стадии',
			allowed: can('set_result'),
			reason: can('set_result') ? null : 'Нет права записывать результат',
			tone: 'default',
			command: { kind: 'result' }
		});
	}

	if (!openRequirement('confirmation')) {
		result.push({
			key: 'confirm',
			label: entry.confirmation === null ? 'Подтвердить стадию' : 'Подтвердить стадию заново',
			allowed: can('confirm'),
			reason: can('confirm') ? null : 'Нет права подтверждать стадию',
			tone: 'default',
			command: { kind: 'confirm' }
		});
	}

	result.push({
		key: 'blocker',
		label: 'Сообщить о помехе',
		allowed: can('raise_blocker'),
		reason: can('raise_blocker') ? null : 'Нет права поднимать помехи',
		tone: 'default',
		command: { kind: 'raise-blocker' }
	});

	result.push({
		key: 'responsible',
		label: 'Передать другому сотруднику',
		allowed: can('set_responsible'),
		reason: can('set_responsible') ? null : 'Нет права менять ответственного',
		tone: 'default',
		command: { kind: 'assign' }
	});

	if (action.kind !== 'complete') {
		result.push({
			key: 'complete',
			label: closing.complete.requiresForce ? 'Завершить досрочно' : 'Завершить взаимодействие',
			allowed: closing.complete.allowed,
			reason: closing.complete.allowed ? null : closing.complete.reasons.join('; '),
			tone: 'default',
			command: { kind: 'complete' }
		});
	}

	result.push({
		key: 'cancel',
		label: 'Отменить взаимодействие',
		allowed: closing.cancel.allowed,
		reason: closing.cancel.allowed ? null : closing.cancel.reasons.join('; '),
		tone: 'danger',
		command: { kind: 'cancel' }
	});

	return result;
}

function describeChange(label: string | null, value: unknown): string {
	if (label !== null) return label;
	if (value === null || value === undefined) return '—';

	return typeof value === 'string' ? value : JSON.stringify(value);
}

const HOUR_SECONDS = 60 * 60;

/** Длительность словами: до суток — часами, дальше — днями. */
function duration(seconds: number): string {
	const rounded = Math.max(0, Math.round(seconds));

	if (rounded < HOUR_SECONDS) {
		return 'меньше часа';
	}

	if (rounded < 24 * HOUR_SECONDS) {
		return pluralize(Math.round(rounded / HOUR_SECONDS), ['час', 'часа', 'часов']);
	}

	return pluralize(Math.round(rounded / (24 * HOUR_SECONDS)), DAYS);
}

/**
 * Сколько запись простояла на стадии — вместе с паузой: «две недели, из них
 * неделю ждали вуз» и «две недели тишины» — разные истории.
 */
function stageDuration(entry: StageEntryView): string {
	const active = `в работе ${duration(entry.activeSeconds)}`;

	return entry.pausedSeconds > 0 ? `${active}, на паузе ${duration(entry.pausedSeconds)}` : active;
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
				duration: null,
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
				duration: stageDuration(entry),
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
				duration: null,
				tone: 'neutral'
			});
		}

		if (entry.confirmedAt !== null && entry.confirmation !== null) {
			events.push({
				id: `confirmed:${entry.id}`,
				at: entry.confirmedAt,
				kind: 'stage',
				title: `«${stageTitle(entry)}» подтверждена`,
				detail: describeConfirmation(entry),
				author: null,
				duration: null,
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
				duration: null,
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
					duration: null,
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
			duration: null,
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
			duration: null,
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
					duration: null,
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
			duration: null,
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
			duration: null,
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
				duration: null,
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
			duration: null,
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
				duration: null,
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
				duration: null,
				tone: 'success'
			});
		}
	}

	return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function buildCard(source: CardSource, now: Date): CardModel {
	const { interaction, status, summary } = source;
	const primary = primaryParty(interaction);
	const stage = summary.happening.stage;
	const action = buildAction(source);

	return {
		id: interaction.id,
		title: interaction.title,
		status: interaction.status,
		workspaceName: interaction.workspaceName,
		shape: counterpartyShape(source.card.counterpartyKind),
		counterparty: {
			name: source.counterparty?.shortName ?? primary?.organizationName ?? 'Контрагент не указан',
			kindLabel: ORGANIZATION_KIND_LABELS[source.card.counterpartyKind]
		},
		modules: source.modules,
		panels: visiblePanels(source.card.panels, source.modules),
		payment: buildPayment(
			status.current === null ? status.history : [status.current, ...status.history],
			source.paymentFact
		),
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
		action,
		primary: primaryCommand(source, action),
		secondary: buildSecondary(source, action),
		events: buildEvents(source)
	};
}
