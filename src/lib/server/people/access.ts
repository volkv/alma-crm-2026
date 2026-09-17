/**
 * Кому виден человек.
 *
 * Отдельным модулем, а не в `directory/read`: по идентификатору человека ходят
 * и справочник, и учёт согласий, и срок хранения, и обезличивание, — а условие
 * видимости у всех у них обязано быть одно. Иначе список фильтрует, а согласие
 * записывается за кого угодно.
 */
import { and, eq, exists, notExists, sql, type SQL } from 'drizzle-orm';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { affiliations, people } from '../db/schema';
import { NotFoundError } from '../errors';
import { visibleOrganizationFilter } from '../interactions/access';
import { scopeFilter } from '../rbac';

/**
 * Человек виден, если хотя бы одна его роль попадает в область доступа — или
 * ролей у него пока нет. Справочник людей общий на оператора, но имена
 * сотрудников чужого вуза — это уже сведения о чужой организации.
 *
 * Это условие **списка**: доступ через видимое взаимодействие его не
 * расширяет — см. {@link personVisible}.
 */
export function personInScope(ctx: ActorContext): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	const db = getDb();
	const anyRole = db
		.select({ one: sql`1` })
		.from(affiliations)
		.where(eq(affiliations.personId, people.id));
	const roleInScope = db
		.select({ one: sql`1` })
		.from(affiliations)
		.where(
			and(eq(affiliations.personId, people.id), scopeFilter(ctx, affiliations.organizationId))
		);

	return sql`(${notExists(anyRole)} or ${exists(roleInScope)})`;
}

/**
 * Карточка человека: то же, что {@link personInScope}, плюс участие в видимом
 * взаимодействии — через основную сторону, у которой он числится.
 *
 * Тому, у кого забрали вуз, а незавершённое взаимодействие осталось, контактные
 * лица этой записи нужны, чтобы её вести. В списке людей они при этом не
 * появляются: список отвечает на вопрос «чьи контакты я веду», а не «до чьих
 * контактов я могу дотянуться».
 */
export function personVisible(ctx: ActorContext): SQL {
	if (ctx.scope.kind === 'all') {
		return sql`true`;
	}

	const viaInteraction = getDb()
		.select({ one: sql`1` })
		.from(affiliations)
		.where(
			and(
				eq(affiliations.personId, people.id),
				visibleOrganizationFilter(ctx, affiliations.organizationId)
			)
		);

	return sql`(${personInScope(ctx)} or ${exists(viaInteraction)})`;
}

/**
 * Человек, которого вызывающему разрешено видеть, или `NotFoundError`.
 *
 * Нужен не только чтению: согласия, срок хранения и обезличивание идут по
 * идентификатору человека, и без этой проверки менеджер записал бы согласие за
 * чужой вуз, ни разу не открыв его карточку. Человек вне области — «не
 * найден», как и везде: разный ответ выдал бы существование чужой записи.
 */
export async function assertPersonVisible(ctx: ActorContext, personId: string): Promise<void> {
	const [row] = await getDb()
		.select({ id: people.id })
		.from(people)
		.where(and(eq(people.id, personId), personVisible(ctx)))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Человек не найден');
	}
}
