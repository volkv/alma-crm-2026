/**
 * Перевод уже лежащих контактов в зашифрованный вид.
 *
 * Колонки шифртекста и ключей сравнения заводит миграция, а значения в них
 * переложить SQL не может: шифрует и считает HMAC приложение, ключ у него в
 * окружении, и в базу он не попадает никогда. Поэтому шаг живёт рядом с
 * применением миграций (`scripts/migrate.ts`) и выполняется тем же запуском,
 * что и они, — на стенде это старт контейнера, в прогоне тестов — подъём базы.
 *
 * Проход идемпотентен: строку с уже зашифрованным значением он не трогает
 * вовсе, поэтому второй запуск не меняет ни байта и не переписывает шифртекст
 * новым вектором. Соединение принимается аргументом — то самое, которым идут
 * миграции: этому шагу не нужны ни адрес Redis, ни хранилище файлов, а
 * `getDb()` потребовал бы конфигурацию целиком.
 */
import type { Sql } from 'postgres';
import { emailColumns, isEncryptedContact, phoneColumns } from './pii';

/** Строка справочника, у которой хотя бы один контакт лежит открытым текстом. */
type StoredRow = {
	id: string;
	email: string | null;
	phone: string | null;
	emailHash: string | null;
	phoneHash: string | null;
};

/**
 * Шифрует открытые контакты и достраивает им ключи сравнения. Возвращает число
 * переписанных строк — его печатает вызывающий, чтобы в логе развёртывания было
 * видно, что именно сделал этот шаг.
 */
export async function encryptStoredContacts(sql: Sql): Promise<number> {
	const rows = await sql<StoredRow[]>`
		select id, email, phone, email_hash as "emailHash", phone_hash as "phoneHash"
		from people
		where (email is not null and email not like 'enc:%')
			or (phone is not null and phone not like 'enc:%')
	`;

	for (const row of rows) {
		// Уже зашифрованная колонка остаётся как есть вместе со своим ключом:
		// перешифровать её значило бы менять данные на каждом запуске, а
		// расшифровывать ради ключа — читать то, что читать незачем.
		const email =
			row.email !== null && !isEncryptedContact(row.email)
				? emailColumns(row.email)
				: { email: row.email, emailHash: row.emailHash };
		const phone =
			row.phone !== null && !isEncryptedContact(row.phone)
				? phoneColumns(row.phone)
				: { phone: row.phone, phoneHash: row.phoneHash };

		await sql`
			update people
			set email = ${email.email},
				email_hash = ${email.emailHash},
				phone = ${phone.phone},
				phone_hash = ${phone.phoneHash}
			where id = ${row.id}
		`;
	}

	return rows.length;
}
