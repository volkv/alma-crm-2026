/**
 * Заявка с сайта в карточке дела: ключ заявки и что сайт о ней знает.
 *
 * Статус заявки уходит на сайт снимками `application.status` (`outbox.ts`
 * обмена). Журнал обмена целиком открыт только администратору, а КАМ
 * спрашивает у карточки одно: какой статус видит заявитель и дошёл ли он.
 * Ответ читается из того же журнала по делу — последнее отправленное тело и
 * исход последнего сообщения, — а не пересчитывается: карточка обязана
 * показывать то, что действительно ушло, а не то, что должно было уйти.
 *
 * Причина отказа доставки сюда не выходит: это адрес и код сетевой ошибки,
 * разбирает её администратор в журнале обмена.
 */
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
	APPLICATION_STATUSES,
	EXCHANGE_EVENT_TYPES,
	parseExternalSource,
	type ApplicationStatus
} from '$lib/contracts/exchange';
import type { InteractionView, SiteApplicationView } from '$lib/contracts/interactions';
import { getDb } from '../db';
import { exchangeMessages } from '../db/schema';

const DELIVERY: Record<
	(typeof exchangeMessages.$inferSelect)['state'],
	NonNullable<SiteApplicationView['delivery']>
> = {
	pending: 'waiting',
	retrying: 'waiting',
	sent: 'delivered',
	processed: 'delivered',
	ignored_stale: 'delivered',
	failed: 'failed',
	dismissed: 'dismissed'
};

function isApplicationStatus(value: unknown): value is ApplicationStatus {
	return typeof value === 'string' && (APPLICATION_STATUSES as readonly string[]).includes(value);
}

/** Статус из замороженного тела отправленного снимка. */
function sentStatus(envelope: string): ApplicationStatus {
	const parsed: unknown = JSON.parse(envelope);
	const status =
		typeof parsed === 'object' && parsed !== null && 'data' in parsed
			? (parsed as { data: { applicationStatus?: unknown } }).data.applicationStatus
			: undefined;

	if (!isApplicationStatus(status)) {
		throw new Error('В отправленном снимке статуса заявки нет её состояния');
	}

	return status;
}

/**
 * Заявка с сайта по делу; `null` — дело заведено не заявкой с сайта. Видимость
 * дела проверена тем, кто прочитал `interaction`.
 */
export async function readSiteApplication(
	interaction: Pick<InteractionView, 'id' | 'externalSource' | 'externalId'>
): Promise<SiteApplicationView | null> {
	if (
		interaction.externalId === null ||
		parseExternalSource(interaction.externalSource)?.system !== 'cms'
	) {
		return null;
	}

	const statusMessages = and(
		eq(exchangeMessages.interactionId, interaction.id),
		eq(exchangeMessages.direction, 'outbound'),
		eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.applicationStatus)
	);

	const [[latest], [delivered]] = await Promise.all([
		getDb()
			.select({ state: exchangeMessages.state })
			.from(exchangeMessages)
			.where(statusMessages)
			.orderBy(desc(exchangeMessages.createdAt))
			.limit(1),
		getDb()
			.select({
				envelope: exchangeMessages.envelope,
				at: exchangeMessages.closedAt,
				createdAt: exchangeMessages.createdAt
			})
			.from(exchangeMessages)
			.where(
				and(
					statusMessages,
					inArray(exchangeMessages.state, ['sent', 'processed']),
					isNotNull(exchangeMessages.envelope)
				)
			)
			.orderBy(desc(exchangeMessages.createdAt))
			.limit(1)
	]);

	return {
		key: interaction.externalId,
		sent:
			delivered === undefined || delivered.envelope === null
				? null
				: { status: sentStatus(delivered.envelope), at: delivered.at ?? delivered.createdAt },
		delivery: latest === undefined ? null : DELIVERY[latest.state]
	};
}
