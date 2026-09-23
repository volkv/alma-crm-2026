/**
 * Управление каталогом учётных записей из прогона e2e.
 *
 * Прогон обязан знать пароли, которыми он входит, и иметь учётные записи, каких
 * в realm нет: штатного администратора стенда и человека без роли. Брать их из
 * `keycloak/realm-lct.json` нельзя — realm описывает **стенд**, а не прогон, и
 * пароль демонстрации там приходит из окружения той машины, на которой подняли
 * контейнер. Поэтому прогон приводит каталог к тому, что ему нужно, через
 * административный интерфейс Keycloak — ровно так же, как приводит базу сидом.
 *
 * Правки идут в тот же realm, что показывает стенд: контейнер один, и второго
 * под прогон не поднимают — Keycloak стартует полторы минуты.
 */

const REALM = 'lct';

type Admin = {
	baseUrl: string;
	token: string;
};

async function request(
	admin: Admin,
	method: string,
	path: string,
	body?: unknown
): Promise<Response> {
	const response = await fetch(`${admin.baseUrl}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${admin.token}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	if (!response.ok) {
		throw new Error(
			`Keycloak отказал: ${method} ${path} → ${response.status} ${await response.text()}`
		);
	}

	return response;
}

/**
 * Токен администратора самого Keycloak (realm `master`). Учётная запись —
 * та же, что поднимает контейнер стека; её значения по умолчанию заданы в
 * `docker-compose.yml`.
 */
export async function keycloakAdmin(baseUrl: string): Promise<Admin> {
	const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'password',
			client_id: 'admin-cli',
			username: process.env.KEYCLOAK_ADMIN ?? 'admin',
			password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin'
		})
	});

	if (!response.ok) {
		throw new Error(
			`Keycloak не выдал токен администратора (${response.status}): проверьте, что контейнер поднят и KEYCLOAK_ADMIN/KEYCLOAK_ADMIN_PASSWORD те же, что у него`
		);
	}

	const body = (await response.json()) as { access_token: string };

	return { baseUrl, token: body.access_token };
}

async function findUserId(admin: Admin, username: string): Promise<string | null> {
	const response = await request(
		admin,
		'GET',
		`/admin/realms/${REALM}/users?username=${encodeURIComponent(username)}&exact=true`
	);
	const users = (await response.json()) as { id: string }[];

	return users[0]?.id ?? null;
}

export type DirectoryAccount = {
	username: string;
	email: string;
	firstName: string;
	lastName: string;
	/** Роль realm; `null` — учётная запись без роли: ею проверяется отказ во входе. */
	realmRole: string | null;
};

/**
 * Приводит учётную запись каталога к тому, что нужно прогону: заводит, если её
 * нет, включает, ставит известный пароль и выдаёт роль.
 *
 * Идемпотентно: второй прогон подряд встречает уже заведённую запись и просто
 * переписывает ей пароль — realm при этом не пересоздаётся.
 */
export async function ensureAccount(
	admin: Admin,
	account: DirectoryAccount,
	password: string
): Promise<void> {
	let userId = await findUserId(admin, account.username);

	if (userId === null) {
		await request(admin, 'POST', `/admin/realms/${REALM}/users`, {
			username: account.username,
			email: account.email,
			firstName: account.firstName,
			lastName: account.lastName,
			// Связывание нашей записи с каталогом принимает только подтверждённую
			// почту — иначе прогон проверял бы вход, которого в жизни не будет.
			emailVerified: true,
			enabled: true
		});

		userId = await findUserId(admin, account.username);

		if (userId === null) {
			throw new Error(`Keycloak завёл запись «${account.username}», но не отдал её обратно`);
		}
	}

	await request(admin, 'PUT', `/admin/realms/${REALM}/users/${userId}/reset-password`, {
		type: 'password',
		value: password,
		temporary: false
	});

	if (account.realmRole !== null) {
		const role = (await (
			await request(admin, 'GET', `/admin/realms/${REALM}/roles/${account.realmRole}`)
		).json()) as { id: string; name: string };

		await request(admin, 'POST', `/admin/realms/${REALM}/users/${userId}/role-mappings/realm`, [
			{ id: role.id, name: role.name }
		]);
	}
}
