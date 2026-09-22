/**
 * Процессы демонстрационного стенда и их назначение пространствам.
 *
 * Сами пространства и соответствие «вид контрагента → пространство» кладёт
 * миграция: без них у взаимодействия нет места, и это не демонстрационные
 * данные, а часть продукта. Набору остаётся описать работу — четырнадцать
 * стадий с вузом и короткий процесс обучения лиц — и сказать, где по ней идут.
 *
 * Два действия вместо одного: процесс живёт сам по себе, и его назначение — это
 * отдельное решение. Порядок важен: пространство без процесса — законное
 * состояние, а процесс без пространства — мусор, поэтому сначала процесс,
 * следом назначение.
 *
 * Стадии кладёт сид, а не миграция, намеренно: навязывать заказчику наши
 * четырнадцать стадий установкой схемы незачем, а заводятся они одной кнопкой.
 */
import type { Tx } from '$lib/server/db/transaction';
import {
	B2B_PROCESS,
	B2B_WORKFLOW_KEY,
	B2B_WORKSPACE_KEY,
	B2C_PROCESS,
	B2C_WORKFLOW_KEY,
	B2C_WORKSPACE_KEY
} from '$lib/server/stages/definitions';
import { assignWorkflow, ensureWorkflow } from '$lib/server/stages/process';

/**
 * Действующие редакции обоих процессов и их назначение. Идемпотентно: процесс,
 * где работа уже описана, не переписывается — на стенде могли применить
 * изменения руками, и сид не имеет права их отменять.
 */
export async function seedProcesses(tx: Tx): Promise<void> {
	await ensureWorkflow(tx, B2B_WORKFLOW_KEY, B2B_PROCESS);
	await ensureWorkflow(tx, B2C_WORKFLOW_KEY, B2C_PROCESS);

	await assignWorkflow(tx, B2B_WORKSPACE_KEY, B2B_WORKFLOW_KEY);
	await assignWorkflow(tx, B2C_WORKSPACE_KEY, B2C_WORKFLOW_KEY);
}
