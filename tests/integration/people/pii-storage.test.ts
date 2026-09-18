/**
 * Что лежит в базе вместо контактов.
 *
 * Маскирование по правам защищает экран, а `select * from people` в консоли
 * базы его не спрашивает: до этой задачи почта и телефон лежали открытым
 * текстом, и доступ к базе означал доступ ко всем контактам справочника.
 * Поэтому проверка смотрит на строку **сырым SQL**, мимо всего кода продукта, —
 * так на неё смотрит тот, от кого защищаются.
 *
 * Здесь же проверяется перевод уже лежащих значений: колонки заводит миграция,
 * а шифрует их шаг `scripts/migrate.ts` — SQL не знает ни ключа, ни алгоритма.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { people } from '$lib/server/db/schema';
import { createPerson, updatePerson } from '$lib/server/directory/write';
import { encryptStoredContacts } from '$lib/server/people/pii-backfill';
import { decryptContact, hashEmail, hashPhone } from '$lib/server/people/pii';
import { anonymizePerson } from '$lib/server/people/retention';
import { getPerson } from '$lib/server/directory/read';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const EMAIL = 'M.Ivanova@vuz.ru';
const PHONE = '+7 (999) 123-45-67';

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

/** Строка справочника глазами того, у кого есть база и нет ключа. */
async function storedRow(id: string) {
	const [row] = await database.raw<
		{
			email: string | null;
			phone: string | null;
			emailHash: string | null;
			phoneHash: string | null;
		}[]
	>`
		select email, phone, email_hash as "emailHash", phone_hash as "phoneHash"
		from people
		where id = ${id}
	`;

	return row;
}

describe('контакты в базе', () => {
	it('лежат шифртекстом: сырой SQL не отдаёт ни адреса, ни номера', async () => {
		const ctx = testActor();
		const person = await createPerson(ctx, {
			lastName: 'Иванова',
			firstName: 'Мария',
			middleName: 'Петровна',
			email: EMAIL,
			phone: PHONE,
			notes: null
		});

		const row = await storedRow(person.id);

		expect(row.email).not.toBeNull();
		expect(row.email).toContain('enc:v1:');
		expect(row.email).not.toContain('Ivanova');
		expect(row.email).not.toContain('vuz.ru');
		expect(row.phone).toContain('enc:v1:');
		expect(row.phone).not.toContain('999');

		// А по ключу расшифровывается то же самое, и сервис отдаёт его как прежде.
		expect(decryptContact(row.email as string)).toBe(EMAIL);
		expect((await getPerson(ctx, person.id)).email).toBe(EMAIL);
	});

	it('несут ключ сравнения, нечувствительный к написанию', async () => {
		const ctx = testActor();
		const person = await createPerson(ctx, {
			lastName: 'Иванова',
			firstName: 'Мария',
			middleName: null,
			email: EMAIL,
			phone: '8 999 123 45 67',
			notes: null
		});

		const row = await storedRow(person.id);

		expect(row.emailHash).toBe(hashEmail(' m.ivanova@vuz.ru '));
		expect(row.phoneHash).toBe(hashPhone(PHONE));
	});

	it('меняются вместе с ключом сравнения при правке', async () => {
		const ctx = testActor();
		const person = await createPerson(ctx, {
			lastName: 'Иванова',
			firstName: 'Мария',
			middleName: null,
			email: EMAIL,
			phone: PHONE,
			notes: null
		});

		await updatePerson(ctx, {
			id: person.id,
			lastName: 'Иванова',
			firstName: 'Мария',
			middleName: null,
			email: 'p.petrova@vuz.ru',
			phone: null,
			notes: null
		});

		const row = await storedRow(person.id);

		expect(row.emailHash).toBe(hashEmail('p.petrova@vuz.ru'));
		expect(row.phone).toBeNull();
		expect(row.phoneHash).toBeNull();
	});

	it('уходят вместе с ключами сравнения при обезличивании', async () => {
		const ctx = testActor();
		const person = await createPerson(ctx, {
			lastName: 'Иванова',
			firstName: 'Мария',
			middleName: null,
			email: EMAIL,
			phone: PHONE,
			notes: null
		});

		await anonymizePerson(ctx, person.id);

		// Ключ сравнения — это по-прежнему сведения о человеке: по нему «он ли
		// писал нам с этой почты» проверяется одним сравнением.
		expect(await storedRow(person.id)).toEqual({
			email: null,
			phone: null,
			emailHash: null,
			phoneHash: null
		});
	});
});

describe('перевод уже лежащих контактов', () => {
	/** Строка, какой она была до этой задачи: контакты открытым текстом. */
	async function insertPlainPerson(): Promise<string> {
		const [row] = await database.raw<{ id: string }[]>`
			insert into people (last_name, first_name, email, phone)
			values ('Петров', 'Пётр', ${EMAIL}, ${PHONE})
			returning id
		`;

		return row.id;
	}

	it('шифрует открытые значения и достраивает им ключи сравнения', async () => {
		const id = await insertPlainPerson();

		expect(await encryptStoredContacts(database.raw)).toBe(1);

		const row = await storedRow(id);

		expect(row.email).toContain('enc:v1:');
		expect(decryptContact(row.email as string)).toBe(EMAIL);
		expect(row.emailHash).toBe(hashEmail(EMAIL));
		expect(row.phoneHash).toBe(hashPhone(PHONE));

		// И после перевода запись читается обычным путём продукта.
		const [person] = await database.db.select().from(people).where(eq(people.id, id));
		expect(decryptContact(person.phone as string)).toBe(PHONE);
	});

	it('на втором проходе не меняет ни байта', async () => {
		const id = await insertPlainPerson();
		await encryptStoredContacts(database.raw);
		const first = await storedRow(id);

		// Ни одной строки к переводу — значит, и шифровать заново нечего: второй
		// вектор у того же значения был бы тихой переписью данных на каждом старте.
		expect(await encryptStoredContacts(database.raw)).toBe(0);
		expect(await storedRow(id)).toEqual(first);
	});

	it('не трогает записи без контактов', async () => {
		await database.raw`insert into people (last_name, first_name) values ('Безконтактов', 'Иван')`;

		expect(await encryptStoredContacts(database.raw)).toBe(0);
	});
});
