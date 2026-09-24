/**
 * Версия правки записи: взаимодействия и договора.
 *
 * Форма несёт версию, с которой её открыли. Команда сверяет её **после**
 * `SELECT … FOR UPDATE` и **до** первой записи: иначе между чтением и
 * блокировкой успела бы пройти чужая правка, и форма молча вернула бы старые
 * значения. Несовпадение — отказ со словами, чью правку человек чуть не затёр;
 * отсутствующая версия до сюда не доходит — её отвергает схема команды.
 *
 * Сдвигают версию только писатели защищённых полей — план, стороны, программы,
 * продукты, договор и его позиции, ответственный. Комментарий, переход,
 * пауза и прочие события полей не переписывают и версию не трогают: иначе
 * живое обсуждение отклоняло бы каждое сохранение плана. Полная матрица —
 * `docs/workflow.md`, «Одновременная работа».
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { EditSource } from '$lib/contracts/interactions';
import { formatTime } from '$lib/format';
import type { ActorContext } from '../actor';
import { users } from '../db/schema';
import type { Tx } from '../db/transaction';
import { ConflictError } from '../errors';

/** Кто делает правку: сотрудник или источник без человека за ним. */
export type Editor = { via: 'user'; userId: string } | { via: Exclude<EditSource, 'user'> };

/** Состояние версии в строке записи — то, что читается под блокировкой. */
export type EditState = {
	editVersion: number;
	editedBy: string | null;
	editedVia: EditSource;
	editedAt: Date;
};

/**
 * Автор правки по контексту запроса: пользователь — он сам, фоновая задача и
 * ключ без пользователя — система. Приём заявки с сайта сюда не ходит: он
 * действует от имени ответственного за входящие, а правку делает сайт.
 */
export function editorOf(ctx: ActorContext): Editor {
	return ctx.user === null ? { via: 'system' } : { via: 'user', userId: ctx.user.id };
}

/** Автор новой записи: её первая версия ставится значением по умолчанию. */
export function firstEdit(editor: Editor): { editedBy: string | null; editedVia: EditSource } {
	return { editedBy: editor.via === 'user' ? editor.userId : null, editedVia: editor.via };
}

/** Столбцы следующей версии: номер на единицу больше, автор и момент — этой правки. */
export function nextEdit(
	editVersion: AnyPgColumn,
	editor: Editor
): { editVersion: SQL; editedBy: string | null; editedVia: EditSource; editedAt: SQL } {
	return {
		...firstEdit(editor),
		editVersion: sql`${editVersion} + 1`,
		// Момент после блокировок, а не начало транзакции: правка, простоявшая в
		// очереди, случилась, когда записалась.
		editedAt: sql`clock_timestamp()`
	};
}

const SOURCE_NAMES: Record<Exclude<EditSource, 'user'>, string> = {
	site: 'изменил сайт',
	system: 'изменила система'
};

async function editorPhrase(tx: Tx, state: EditState): Promise<string> {
	if (state.editedVia !== 'user') {
		return SOURCE_NAMES[state.editedVia];
	}

	if (state.editedBy === null) {
		throw new Error('Правка сотрудника записана без автора: ограничение базы нарушено');
	}

	const [user] = await tx
		.select({ fullName: users.fullName })
		.from(users)
		.where(eq(users.id, state.editedBy))
		.limit(1);

	if (user === undefined) {
		throw new Error(`Автор правки ${state.editedBy} не найден`);
	}

	return `изменил ${user.fullName}`;
}

/**
 * Сверка версии формы с версией записи. Зовётся под блокировкой строки и до
 * первой записи команды.
 */
export async function assertEditVersion(tx: Tx, state: EditState, expected: number): Promise<void> {
	if (state.editVersion === expected) {
		return;
	}

	throw new ConflictError(
		`Запись ${await editorPhrase(tx, state)} в ${formatTime(state.editedAt)} — обновите карточку, ваш ввод сохранён`
	);
}
