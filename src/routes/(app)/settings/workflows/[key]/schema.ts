/**
 * Формы экрана процесса: стадия и переход.
 *
 * Они не повторяют контракт (`stageDefinitionSchema`, `stageTransitionDefinitionSchema`),
 * а описывают то, что вводит человек: позицию в цепочке, чек-лист списком
 * пунктов и ключ правимой записи. Сервер собирает из этого структуру процесса целиком и
 * отдаёт её `updateDraft` — проверять её второй раз здесь не надо, схема
 * контракта никуда не делась.
 */
import { z } from 'zod';
import { requiredText } from '$lib/contracts/common';
import { DOCUMENT_STATUS_FACTS, DOCUMENT_TEMPLATE_KEYS } from '$lib/contracts/documents';
import { LEARNING_PURPOSES } from '$lib/contracts/exchange';
import {
	STAGE_CATEGORIES,
	STAGE_ENTER_NOTIFY_TARGETS,
	STAGE_TRANSITION_KINDS
} from '$lib/contracts/interactions';
import { CHECKLIST_ACTION_KEYS } from '$lib/platform/checklist';
import { CHECKLIST_RULE_KEYS } from '$lib/platform/checklist-rules';

/**
 * Ключ стадии. Он уезжает в базу и в слепки уже пройденных стадий, поэтому
 * пишется латиницей и живёт дольше названия: по нему записи сопоставляются со
 * структурой при изменении процесса. Форма предлагает его из названия.
 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

const KEY_ERROR = 'Ключ — латиница в нижнем регистре, цифры, «_» и «-», начиная с буквы';

/**
 * Пункт чек-листа в форме. Ключ пуст у пункта, добавленного сейчас: его
 * собирает сервер из названия. У сохранённого пункта ключ приезжает обратно
 * без изменений — по нему в идущих делах хранятся отметки.
 *
 * Пустые строки — «нет»: без пояснения, ручная отметка вместо правила, без
 * кнопки. Пустой выбор в списке не отличить от невыбранного.
 */
const checklistItemFormSchema = z.object({
	key: z.union([z.literal(''), z.string().regex(KEY_PATTERN, { error: KEY_ERROR }).max(100)]),
	label: requiredText(300, 'Назовите пункт чек-листа или удалите его'),
	required: z.boolean(),
	help: z.string().trim().max(500, { error: 'Пояснение — не длиннее 500 символов' }).default(''),
	rule: z.enum(['', ...CHECKLIST_RULE_KEYS], { error: 'Такого правила проверки нет' }).default(''),
	action: z.enum(['', ...CHECKLIST_ACTION_KEYS], { error: 'Такого действия нет' }).default('')
});

export type ChecklistItemForm = z.output<typeof checklistItemFormSchema>;

/**
 * Числовое поле формы. Пустое поле приходит как `null`, а не как ноль: ноль у
 * норматива — настоящее значение («стадия просрочена в момент входа»), и
 * подменять им пустоту нельзя.
 */
function days(message: string, min: number) {
	return z
		.number({ error: message })
		.int({ error: message })
		.min(min, { error: `${message}, не меньше ${min}` })
		.max(365, { error: `${message}, не больше года` })
		.nullable();
}

export const stageFormSchema = z
	.object({
		/** Ключ правимой стадии; пусто — заводится новая. */
		originalKey: z.string().trim().max(100).default(''),
		/** Место в цепочке; пусто — в конец. */
		position: z
			.number({ error: 'Позиция — целое число' })
			.int({ error: 'Позиция — целое число' })
			.min(1, { error: 'Позиция в маршруте начинается с единицы' })
			.max(200, { error: 'Позиция не больше 200' })
			.nullable(),
		key: requiredText(100, 'Укажите ключ стадии').regex(KEY_PATTERN, { error: KEY_ERROR }),
		name: requiredText(300, 'Укажите название стадии'),
		category: z.enum(STAGE_CATEGORIES, { error: 'Выберите смысловую группу стадии' }),
		/** Обязателен: из него считается срок стадии. */
		slaDays: days('Норматив — целое число дней', 0),
		/** Пусто — стадия не подсвечивает тишину; в базе это `null`. */
		staleAfterDays: days('Срок без событий — целое число дней', 1),
		requiresResult: z.boolean().default(false),
		requiresConfirmation: z.boolean().default(false),
		requiresLmsData: z.boolean().default(false),
		/** Пусто — отметки не требуется; в базе это `null`. */
		requiresDocumentMark: z.enum(['', ...DOCUMENT_STATUS_FACTS]).default(''),
		/** Пусто — отметка засчитывается на любом документе дела; в базе это `null`. */
		requiresDocumentTemplate: z.enum(['', ...DOCUMENT_TEMPLATE_KEYS]).default(''),
		/** Ни одного — итог группы любого назначения; в базе это `null`. */
		lmsGroupPurposes: z.array(z.enum(LEARNING_PURPOSES)).default([]),
		/** Пусто — при входе никого не уведомлять; в базе это `null`. */
		onEnterNotify: z.enum(['', ...STAGE_ENTER_NOTIFY_TARGETS]).default(''),
		isFinal: z.boolean().default(false),
		checklist: z
			.array(checklistItemFormSchema)
			.max(30, { error: 'В чек-листе не больше 30 пунктов' })
			.default([])
	})
	.superRefine((value, ctx) => {
		if (value.slaDays === null) {
			ctx.addIssue({
				code: 'custom',
				path: ['slaDays'],
				message: 'Укажите норматив в днях: из него считается срок стадии'
			});
		}

		if (value.requiresDocumentTemplate !== '' && value.requiresDocumentMark === '') {
			ctx.addIssue({
				code: 'custom',
				path: ['requiresDocumentTemplate'],
				message: 'Шаблон документа задают вместе с требуемой отметкой'
			});
		}

		if (value.lmsGroupPurposes.length > 0 && !value.requiresLmsData) {
			ctx.addIssue({
				code: 'custom',
				path: ['lmsGroupPurposes'],
				message: 'Назначения групп задают у стадии, которая требует данных обучения'
			});
		}
	});

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
