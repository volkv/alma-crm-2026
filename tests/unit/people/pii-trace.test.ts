/**
 * След просмотра персональных данных: одно событие на чтение, а не на строку.
 *
 * Журнал здесь подменён: проверяется не запись в базу, а то, сколько раз и с
 * какими подробностями сервис решил её сделать. Именно это правило ломается
 * незаметнее всего — стоит обернуть чтения по отдельности, и открытая карточка
 * начнёт оставлять по событию на каждый вложенный запрос.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '$lib/server/actor';
import type { PersonRecord } from '$lib/server/people/serialize';

const recordAuditEvent = vi.fn();

vi.mock('$lib/server/audit', () => ({
	recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args)
}));

const { notePiiView, withPiiTrace } = await import('$lib/server/people/pii-trace');
const { toPersonView } = await import('$lib/server/people/serialize');

const PERSON_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function actor(requestId: string, permissions: readonly string[]): ActorContext {
	return {
		requestId,
		source: 'ui',
		user: {
			id: '00000000-0000-4000-8000-0000000000a1',
			email: 'tester@example.org',
			fullName: 'Тестовый Пользователь',
			roleId: 'manager',
			permissions: new Set(permissions),
			isDemo: false,
			scope: { kind: 'all' }
		},
		apiKeyId: null,
		ip: null,
		userAgent: null,
		scope: { kind: 'all' }
	};
}

function person(id: string): PersonRecord {
	return {
		id,
		lastName: 'Иванов',
		firstName: 'Иван',
		middleName: null,
		email: 'ivanov@vuz.ru',
		phone: '+7 900 000-00-01',
		notes: null,
		retentionUntil: null,
		anonymizedAt: null
	};
}

/** Подробности единственного записанного события. */
function details(): Record<string, unknown> {
	expect(recordAuditEvent).toHaveBeenCalledTimes(1);

	const [, event] = recordAuditEvent.mock.calls[0] as [
		unknown,
		{ details: Record<string, unknown> }
	];

	return event.details;
}

beforeEach(() => {
	recordAuditEvent.mockClear();
});

describe('след просмотра персональных данных', () => {
	it('пишет одно событие на чтение, сколько бы людей в нём ни раскрыли', async () => {
		const ctx = actor('request-one', ['people.read', 'people.read_pii']);

		await withPiiTrace(ctx, async () => {
			toPersonView(ctx, person(PERSON_ID));
			toPersonView(ctx, person(OTHER_ID));
			// Тот же человек второй раз — та же строка списка, не второе раскрытие.
			toPersonView(ctx, person(PERSON_ID));
		});

		expect(details()).toEqual({ personIds: [PERSON_ID, OTHER_ID] });
	});

	it('складывает вложенные области сбора в одну', async () => {
		const ctx = actor('request-nested', ['people.read', 'people.read_pii']);

		await withPiiTrace(ctx, async () => {
			await withPiiTrace(ctx, async () => toPersonView(ctx, person(PERSON_ID)));
			await withPiiTrace(ctx, async () => toPersonView(ctx, person(OTHER_ID)));
		});

		expect(details()).toEqual({ personIds: [PERSON_ID, OTHER_ID] });
	});

	it('складывает и параллельные области — карточка читает человека и его роли разом', async () => {
		const ctx = actor('request-parallel', ['people.read', 'people.read_pii']);

		await Promise.all([
			withPiiTrace(ctx, async () => toPersonView(ctx, person(PERSON_ID))),
			withPiiTrace(ctx, async () => toPersonView(ctx, person(OTHER_ID)))
		]);

		expect(details()).toEqual({ personIds: [PERSON_ID, OTHER_ID] });
	});

	it('не пишет ничего, когда контакты показаны замаскированными', async () => {
		const ctx = actor('request-masked', ['people.read']);

		await withPiiTrace(ctx, async () => toPersonView(ctx, person(PERSON_ID)));

		expect(recordAuditEvent).not.toHaveBeenCalled();
	});

	it('не пишет ничего, когда раскрывать было нечего', async () => {
		const ctx = actor('request-empty', ['people.read', 'people.read_pii']);

		await withPiiTrace(ctx, async () =>
			toPersonView(ctx, { ...person(PERSON_ID), email: null, phone: null })
		);

		expect(recordAuditEvent).not.toHaveBeenCalled();
	});

	it('закрывает область и после ошибки чтения', async () => {
		const ctx = actor('request-failed', ['people.read', 'people.read_pii']);

		await expect(
			withPiiTrace(ctx, async () => {
				toPersonView(ctx, person(PERSON_ID));
				throw new Error('выборка упала');
			})
		).rejects.toThrow('выборка упала');

		// Событие всё равно записано: контакты человеку уже показали.
		expect(details()).toEqual({ personIds: [PERSON_ID] });

		// И область не осталась открытой: следующая отметка вне чтения пропадает.
		notePiiView(ctx, OTHER_ID);
		expect(recordAuditEvent).toHaveBeenCalledTimes(1);
	});

	it('разводит запросы по идентификатору: чужое чтение в чужое событие не попадает', async () => {
		const first = actor('request-a', ['people.read', 'people.read_pii']);
		const second = actor('request-b', ['people.read', 'people.read_pii']);

		await Promise.all([
			withPiiTrace(first, async () => toPersonView(first, person(PERSON_ID))),
			withPiiTrace(second, async () => toPersonView(second, person(OTHER_ID)))
		]);

		expect(recordAuditEvent).toHaveBeenCalledTimes(2);

		const written = recordAuditEvent.mock.calls.map(
			([, event]) => (event as { details: { personIds: string[] } }).details.personIds
		);

		expect(written).toEqual([[PERSON_ID], [OTHER_ID]]);
	});
});
