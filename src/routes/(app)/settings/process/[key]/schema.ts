/**
 * Формы экрана процесса: стадия, переход и удаление стадии.
 *
 * Они не повторяют контракт (`stageDefinitionSchema`, `stageTransitionDefinitionSchema`),
 * а описывают то, что вводит человек: позицию в цепочке, чек-лист строками и
 * ключ правимой записи. Сервер собирает из этого структуру процесса целиком и
 * отдаёт её `updateDraft` — проверять её второй раз здесь не надо, схема
 * контракта никуда не делась.
 */
import { z } from 'zod';
import { requiredText } from '$lib/contracts/common';
import {
	STAGE_CATEGORIES,
	STAGE_TRANSITION_KINDS,
	type ChecklistItem
} from '$lib/contracts/interactions';

/**
 * Ключ стадии и пункта чек-листа. Он уезжает в базу и в слепки уже пройденных
 * стадий, поэтому пишется латиницей и живёт дольше названия: по нему записи
 * сопоставляются со структурой при изменении процесса.
 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

const KEY_ERROR = 'Ключ — латиница в нижнем регистре, цифры, «_» и «-», начиная с буквы';

/** Как записывается чек-лист стадии; текст стоит под полем формы. */
export const CHECKLIST_HINT =
	'По пункту в строке: «ключ: название». Звёздочка в начале строки — пункт обязателен для перехода вперёд.';

export type ChecklistParse = {
	items: ChecklistItem[];
	/** Претензии к строкам — по одной на строку, с её номером. */
	issues: string[];
};

/**
 * Чек-лист из текста поля. Разбирает построчно и называет номер строки: в
 * списке из четырёх пунктов «неверный формат» не говорит, какой именно пункт
 * править.
 */
export function parseChecklist(text: string): ChecklistParse {
	const items: ChecklistItem[] = [];
	const issues: string[] = [];
	const seen = new Set<string>();

	text.split('\n').forEach((raw, index) => {
		const line = raw.trim();

		if (line === '') {
			return;
		}

		const number = index + 1;
		const required = line.startsWith('*');
		const body = (required ? line.slice(1) : line).trim();
		const separator = body.indexOf(':');

		if (separator === -1) {
			issues.push(`Строка ${number}: пункт пишется как «ключ: название»`);
			return;
		}

		const key = body.slice(0, separator).trim();
		const label = body.slice(separator + 1).trim();

		if (!KEY_PATTERN.test(key) || key.length > 100) {
			issues.push(`Строка ${number}: ключ «${key}» не подходит. ${KEY_ERROR}`);
			return;
		}

		if (label === '') {
			issues.push(`Строка ${number}: у пункта «${key}» нет названия`);
			return;
		}

		if (label.length > 300) {
			issues.push(`Строка ${number}: название пункта не длиннее 300 символов`);
			return;
		}

		if (seen.has(key)) {
			issues.push(`Строка ${number}: ключ «${key}» в чек-листе уже есть`);
			return;
		}

		seen.add(key);
		items.push({ key, label, required });
	});

	return { items, issues };
}

/** Чек-лист в том виде, в каком его правят в поле. */
export function formatChecklist(items: readonly ChecklistItem[]): string {
	return items.map((item) => `${item.required ? '* ' : ''}${item.key}: ${item.label}`).join('\n');
}

export const stageFormSchema = z
	.object({
		/** Ключ правимой стадии; пусто — заводится новая. */
		originalKey: z.string().trim().max(100).default(''),
		position: z
			.number({ error: 'Позиция — целое число' })
			.int({ error: 'Позиция — целое число' })
			.min(1, { error: 'Позиция в маршруте начинается с единицы' })
			.max(200, { error: 'Позиция не больше 200' }),
		key: requiredText(100, 'Укажите ключ стадии').regex(KEY_PATTERN, { error: KEY_ERROR }),
		name: requiredText(300, 'Укажите название стадии'),
		category: z.enum(STAGE_CATEGORIES, { error: 'Выберите смысловую группу стадии' }),
		slaDays: z
			.number({ error: 'Норматив стадии — целое число дней' })
			.int({ error: 'Норматив стадии — целое число дней' })
			.min(0, { error: 'Норматив стадии не может быть отрицательным' })
			.max(365, { error: 'Норматив стадии не длиннее года' }),
		/** Ноль — стадия не протухает; в базе это `null`. */
		staleAfterDays: z
			.number({ error: 'Срок протухания — целое число дней' })
			.int({ error: 'Срок протухания — целое число дней' })
			.min(0, { error: 'Срок протухания не может быть отрицательным' })
			.max(365, { error: 'Срок протухания не длиннее года' }),
		requiresResult: z.boolean().default(false),
		requiresConfirmation: z.boolean().default(false),
		requiresLmsData: z.boolean().default(false),
		isFinal: z.boolean().default(false),
		checklist: z.string().max(4000, { error: 'Чек-лист не длиннее 4000 символов' }).default('')
	})
	.superRefine((value, ctx) => {
		for (const issue of parseChecklist(value.checklist).issues) {
			ctx.addIssue({ code: 'custom', path: ['checklist'], message: issue });
		}
	});

export type StageFormInput = z.output<typeof stageFormSchema>;

export const transitionFormSchema = z
	.object({
		/** Пара «откуда — куда» правимого перехода; пусто — заводится новый. */
		originalFromKey: z.string().trim().max(100).default(''),
		originalToKey: z.string().trim().max(100).default(''),
		fromStageKey: requiredText(100, 'Выберите стадию, с которой возможен переход'),
		toStageKey: requiredText(100, 'Выберите стадию, на которую ведёт переход'),
		kind: z.enum(STAGE_TRANSITION_KINDS, { error: 'Выберите вид перехода' }),
		requiredPermissionKey: requiredText(100, 'Выберите право, которое требует переход'),
		requiresReason: z.boolean().default(false)
	})
	.refine((value) => value.fromStageKey !== value.toStageKey, {
		error: 'Переход не может вести на ту же стадию',
		path: ['toStageKey']
	});

export type TransitionFormInput = z.output<typeof transitionFormSchema>;

/**
 * Удаление стадии. Цель переноса спрашивается здесь же: «куда переедут те, кто
 * стоит на ней сейчас» — часть решения об удалении, а не следующий шаг, о
 * котором можно забыть. Пусто — цель по умолчанию: предыдущая сохранившаяся
 * стадия, а у первой — следующая.
 */
export const removeStageFormSchema = z.object({
	key: requiredText(100, 'Не указано, какую стадию удалять'),
	targetStageKey: z.string().trim().max(100).default('')
});

export type RemoveStageFormInput = z.output<typeof removeStageFormSchema>;
