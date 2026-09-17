/**
 * Пул соединений против записей, которые идут рядом с транзакцией.
 *
 * Приём заявки с сайта собирает организацию, человека, его роль и
 * взаимодействие одной транзакцией — она держит соединение от начала до конца.
 * А след просмотра персональных данных (`people.pii_viewed`), как и отказы
 * журнала, обязан пережить откат и потому пишется отдельным соединением. Пока
 * такая запись шла из-под открытой транзакции, десяток одновременных заявок
 * запирал базу насмерть: все держат по соединению и все ждут второго, а отдать
 * первое некому. Очередь в этом случае сама не рассасывается — запрос висит до
 * таймаута клиента, и лечится это перезапуском.
 *
 * Проверяются обе стороны починки. Приём держит одну область сбора следа на
 * весь запрос и снаружи транзакции, поэтому второго соединения ему не нужно
 * вовсе (а область, закрытая внутри транзакции, пишет её же исполнителем — см.
 * `tests/unit/people/pii-trace.test.ts`). И пул задан явно и с запасом на
 * записи, которые всё-таки идут рядом с транзакцией, — отказы журнала.
 *
 * Всё это проверяется настоящей нагрузкой на настоящую базу: с одним
 * соединением или с заглушкой пула такой отказ не воспроизводится в принципе.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationIntakeSchema } from '$lib/contracts/integrations';
import type { ActorContext } from '$lib/server/actor';
import { auditEvents } from '$lib/server/db/schema';
import { createPerson } from '$lib/server/directory/write';
import { receiveApplication } from '$lib/server/integrations/intake';
import { B2B_GROUP_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import { ensureProcess } from '$lib/server/stages/process';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Сколько заявок приходит разом. Больше, чем соединений в пуле по умолчанию у
 * `postgres.js` (их десять): пока размер пула не задан явно, форма на сайте,
 * отправившая накопленное пачкой, запирает базу целиком.
 */
const SIMULTANEOUS_APPLICATIONS = 12;

/**
 * Потолок ожидания. Запертый пул не отпускает сам, и без потолка тест висел бы
 * до конца прогона вместо того, чтобы назвать причину.
 */
const DEADLINE_MS = 30_000;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	await database.db.transaction(async (tx) => {
		await ensureProcess(tx, B2B_GROUP_KEY, B2B_PROCESS);
	});
});

/**
 * Своё действующее лицо на заявку. Идентификатор запроса у каждого свой:
 * область сбора следа просмотра ведётся по нему, и один идентификатор на всех
 * склеил бы двенадцать заявок в одну запись журнала — то есть убрал бы из
 * проверки ровно то, что она проверяет.
 */
function siteActor(): ActorContext {
	return { ...testActor(), requestId: crypto.randomUUID() };
}

/** Заявка с сайта: у каждой своя организация и свой контакт, сверять нечего. */
function application(index: number) {
	return applicationIntakeSchema.parse({
		externalId: `site-2026-${String(index).padStart(6, '0')}`,
		organization: {
			name: `Институт прикладных исследований № ${index}`,
			inn: null,
			kind: 'educational_institution',
			educationLevel: 'vo'
		},
		contact: {
			lastName: 'Кузьмина',
			firstName: 'Наталья',
			middleName: 'Петровна',
			email: `kuzmina-${index}@example.org`,
			phone: '+7 900 000-00-11',
			position: 'Проректор по цифровому развитию'
		},
		interest: 'Программа подготовки по прикладной информатике',
		comment: null
	});
}

/** Ожидание с потолком: не уложились — значит, пул заперт, и так и надо сказать. */
async function withinDeadline<TResult>(work: Promise<TResult>): Promise<TResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`Заявки не приняты за ${DEADLINE_MS} мс: транзакции держат соединения и ждут свободного — пул заперт`
					)
				),
			DEADLINE_MS
		);
	});

	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

describe('пул соединений', () => {
	it(
		'выдерживает пачку одновременных заявок: транзакция и запись рядом не запирают базу',
		async () => {
			const results = await withinDeadline(
				Promise.all(
					Array.from({ length: SIMULTANEOUS_APPLICATIONS }, (_, index) =>
						receiveApplication(siteActor(), application(index))
					)
				)
			);

			expect(results).toHaveLength(SIMULTANEOUS_APPLICATIONS);
			expect(results.filter((result) => result.created)).toHaveLength(SIMULTANEOUS_APPLICATIONS);

			// Следы просмотра на месте, и их ровно по одному на заявку: приём держит
			// одну область сбора на весь запрос, сколько бы записей справочника он
			// внутри себя ни завёл.
			const traces = await database.db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.eventType, 'people.pii_viewed'));

			expect(traces).toHaveLength(SIMULTANEOUS_APPLICATIONS);
		},
		DEADLINE_MS + 30_000
	);

	it('след, открытый внутри транзакции, пишется её же исполнителем', async () => {
		const ctx = siteActor();

		await database.db.transaction(async (tx) => {
			await createPerson(
				ctx,
				{
					lastName: 'Кузьмина',
					firstName: 'Наталья',
					middleName: null,
					email: 'kuzmina@example.org',
					phone: '+7 900 000-00-11',
					notes: null
				},
				tx
			);

			const inside = await tx
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.eventType, 'people.pii_viewed'));

			expect(inside).toHaveLength(1);

			// А другому соединению записи ещё не видно: она принадлежит транзакции и
			// появится с её фиксацией. Соединение за ней не занималось — иначе
			// транзакция ждала бы его из пула, не отпуская своего.
			const outside = await database.db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.eventType, 'people.pii_viewed'));

			expect(outside).toHaveLength(0);
		});
	});
});
