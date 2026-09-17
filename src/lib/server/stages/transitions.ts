/**
 * Готовность перехода: одна функция на весь продукт.
 *
 * Один и тот же вопрос — «можно ли сейчас перейти на эту стадию» — задают
 * карточка (чтобы показать кнопку и объяснить, почему она недоступна), API и
 * сама команда перехода. Ответ обязан быть один: правило, продублированное в
 * интерфейсе и в сервисе, однажды разойдётся, и разойдётся оно молча.
 *
 * Поэтому здесь чистая функция: состояние стадии и описание перехода на входе,
 * приговор с причинами отказа на выходе. Ни базы, ни HTTP — только правила.
 *
 * На шаге вперёд задаётся пять вопросов стадии: снята ли пауза, закрыты ли
 * обязательные пункты чек-листа, записан ли результат, есть ли подтверждение и
 * получены ли данные обучения. На возврате и пропуске они не задаются
 * намеренно: возврат — выход из тупика, и требовать для него закрытый чек-лист
 * значит запереть процесс там, где он застрял.
 */
import type {
	ChecklistState,
	StageConfirmation,
	StageSnapshot,
	StageTransitionView
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { can } from '../rbac';
import { PERMISSION_KEYS, type PermissionKey } from '../rbac/permissions';

/** Состояние открытой стадии в объёме, который нужен правилам перехода. */
export type StageState = {
	/** Стадия, на которой взаимодействие стоит прямо сейчас. */
	stageId: string;
	/** Слепок стадии: чек-лист и требования берутся из него, а не из структуры. */
	snapshot: StageSnapshot;
	checklistState: ChecklistState;
	resultText: string | null;
	confirmation: StageConfirmation | null;
	/** Факты системы обучения по взаимодействию; `null` — их ещё не получали. */
	lmsEvidence: unknown;
	isPaused: boolean;
	/** Сколько открытых помех запрещают движение дальше. */
	blockingBlockers: number;
};

/**
 * Команда, которую собираются выполнить. У сводки её нет (`null`): сводка
 * отвечает на вопрос «что мешает прямо сейчас», а причину перехода человек
 * вводит в диалоге, и требовать её заранее — значит показывать отказ там, где
 * отказа нет.
 */
export type TransitionIntent = {
	/** Объяснение перехода: у возврата и пропуска — причина, у шага вперёд — комментарий. */
	reason?: string | null;
	/** Результат, который команда запишет вместе с переходом. */
	resultText?: string | null;
	/** Отметки чек-листа, которые команда применит вместе с переходом. */
	checklistState?: ChecklistState;
};

export type TransitionVerdict = {
	allowed: boolean;
	/** Почему нельзя — по одной фразе на причину, в том виде, в каком её видит человек. */
	reasons: string[];
};

const knownPermissions = new Set<string>(PERMISSION_KEYS);

/**
 * Право перехода приезжает из описания процесса, то есть из базы. Код,
 * которого нет в каталоге, ничего не разрешает: иначе строку в конфигурации
 * можно было бы превратить в обход проверки прав.
 */
export function transitionPermission(transition: StageTransitionView): PermissionKey | null {
	return knownPermissions.has(transition.requiredPermissionKey)
		? (transition.requiredPermissionKey as PermissionKey)
		: null;
}

function isBlank(value: string | null | undefined): boolean {
	return value === null || value === undefined || value.trim() === '';
}

export function evaluateTransition(
	ctx: ActorContext,
	state: StageState,
	transition: StageTransitionView,
	intent: TransitionIntent | null = null
): TransitionVerdict {
	const reasons: string[] = [];
	const permission = transitionPermission(transition);

	if (permission === null) {
		reasons.push(
			`Переход требует права «${transition.requiredPermissionKey}», которого нет в каталоге`
		);
	} else if (!can(ctx, permission)) {
		reasons.push(`Недостаточно прав: требуется «${permission}»`);
	}

	if (state.stageId !== transition.fromStageId) {
		reasons.push('Взаимодействие уже не на той стадии, с которой возможен этот переход');
	}

	if (state.blockingBlockers > 0) {
		reasons.push('Есть открытые помехи, запрещающие переход');
	}

	// Возврат и пропуск — это выход из тупика, и требовать для них результат,
	// подтверждение и закрытый чек-лист значит запереть процесс ровно там, где
	// он и застрял. Требования стадии проверяются только на шаге вперёд.
	if (transition.kind === 'forward') {
		if (state.isPaused) {
			reasons.push('Стадия на паузе: сначала снимите паузу');
		}

		const checklistState = { ...state.checklistState, ...(intent?.checklistState ?? {}) };

		for (const item of state.snapshot.checklist) {
			if (item.required && checklistState[item.key] !== true) {
				reasons.push(`Не закрыт обязательный пункт чек-листа: «${item.label}»`);
			}
		}

		if (state.snapshot.requiresResult && isBlank(intent?.resultText ?? state.resultText)) {
			reasons.push('У стадии не записан результат');
		}

		if (state.snapshot.requiresConfirmation && state.confirmation === null) {
			reasons.push('Стадия не подтверждена');
		}

		// Пятый вопрос стадии: получены ли факты из системы обучения. Признак
		// включают там, где обмен двусторонний; без него требование, которое
		// нечем выполнить, заперло бы процесс.
		if (state.snapshot.requiresLmsData && state.lmsEvidence === null) {
			reasons.push('По стадии не получены данные системы обучения');
		}
	}

	// Требование объяснения принадлежит переходу, а не его виду: процесс вправе
	// включить его и на шаге вперёд, и тогда оно проверяется здесь так же.
	if (transition.requiresReason && intent !== null && isBlank(intent.reason)) {
		reasons.push('Нужно объяснить причину');
	}

	return { allowed: reasons.length === 0, reasons };
}
