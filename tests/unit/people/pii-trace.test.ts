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
import type { Tx } from '$lib/server/db/transaction';
import type { PersonRecord } from '$lib/server/people/serialize';

const recordAuditEvent = vi.fn();

vi.mock('$lib/server/audit', () => ({
	recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args)
}));

/**
 * Контакты в строке справочника лежат шифртекстом, и сериализатор их
 * расшифровывает — значит, ключ нужен и здесь. Берётся он из подменённого
 * окружения: в прогоне CI никакого `.env` нет.
 */
vi.mock('$env/dynamic/private', () => ({
	env: { PII_ENCRYPTION_KEY: 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=' }
}));

const { encryptContact } = await import('$lib/server/people/pii');
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
		email: encryptContact('ivanov@vuz.ru'),
		phone: encryptContact('+7 900 000-00-01'),
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

/** Кому досталась запись единственного события: исполнитель транзакции или никто. */
function writer(): unknown {
	expect(recordAuditEvent).toHaveBeenCalledTimes(1);

	return (recordAuditEvent.mock.calls[0] as unknown[])[2];
}

/**
 * Исполнитель транзакции. Настоящий не нужен: журнал здесь подменён, и
 * проверяется не запись в базу, а то, кому её отдали.
 */
const transaction = { label: 'tx' } as unknown as Tx;

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

	it('пишет событие исполнителем транзакции, внутри которой открыта область', async () => {
		const ctx = actor('request-in-transaction', ['people.read', 'people.read_pii']);

		await withPiiTrace(ctx, async () => toPersonView(ctx, person(PERSON_ID)), transaction);

		// Иначе запись ушла бы другим соединением, пока транзакция держит своё, и
		// десяток одновременных операций запер бы пул.
		expect(writer()).toBe(transaction);
	});

	it('после ошибки чтения пишет событие вне транзакции, даже когда она известна', async () => {
		const ctx = actor('request-failed-in-transaction', ['people.read', 'people.read_pii']);

		await expect(
			withPiiTrace(
				ctx,
				async () => {
					toPersonView(ctx, person(PERSON_ID));
					throw new Error('выборка упала');
				},
				transaction
			)
		).rejects.toThrow('выборка упала');

		// Транзакция после ошибки базы вставки уже не примет, а её отказ заменил бы
		// собой исходную ошибку — ту самую, по которой вызывающий и разбирается,
		// что случилось. Да и откат унёс бы запись о показанных контактах.
		expect(writer()).toBeUndefined();
	});

	it('отдаёт запись той области, что закрылась последней: внешняя — значит, после транзакции', async () => {
		const ctx = actor('request-around-transaction', ['people.read', 'people.read_pii']);

		// Так устроен приём заявки: область на весь запрос, внутри неё транзакция,
		// а внутри транзакции — чтения, которые объявляют свою область со своим
		// исполнителем. Событие одно, и пишется оно уже после коммита.
		await withPiiTrace(ctx, async () => {
			await withPiiTrace(ctx, async () => toPersonView(ctx, person(PERSON_ID)), transaction);
			await withPiiTrace(ctx, async () => toPersonView(ctx, person(OTHER_ID)), transaction);
		});

		expect(writer()).toBeUndefined();
		expect(details()).toEqual({ personIds: [PERSON_ID, OTHER_ID] });
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
