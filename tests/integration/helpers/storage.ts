/**
 * Настоящее хранилище файлов для интеграционных тестов.
 *
 * SeaweedFS поднимается один раз на прогон (`global-setup.ts`), а файл тестов
 * получает в нём свой бакет — по той же причине, по какой так устроены
 * PostgreSQL и Redis: прогон не должен ни зависеть от того, что оставил
 * предыдущий, ни мешать соседнему, а контейнер на файл покупал это свойство
 * впятеро дороже, чем нужно. Заглушка здесь не годится совсем: проверяется
 * ровно то, как ведёт себя S3 — отсутствующий объект, повторная запись, чтение
 * потоком, — и подделка проверяла бы подделку.
 *
 * Свой клиент, а не тот, которым ходит приложение: проверка должна смотреть на
 * хранилище со стороны, иначе сломанный код хранилища подтвердил бы сам себя.
 */
import {
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	S3Client
} from '@aws-sdk/client-s3';
import { GenericContainer, Wait } from 'testcontainers';

/** Тот же образ, что в `docker-compose.yml`: тесты и стенд ходят в одну версию. */
const IMAGE = 'chrislusf/seaweedfs:4.48';

/** Порт S3-шлюза внутри контейнера. */
const S3_PORT = 8333;

const REGION = 'us-east-1';
const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key';

/** Координаты поднятого хранилища: по ним заводится бакет файла тестов. */
export type StorageServer = {
	endpoint: string;
	region: string;
	accessKey: string;
	secretKey: string;
};

export type TestStorage = {
	/** Переменные окружения, которыми сервисы находят это хранилище. */
	env: Readonly<Record<string, string>>;
	/** Ключи объектов под префиксом, по возрастанию. */
	keys: (prefix: string) => Promise<string[]>;
	/** Содержимое объекта; отсутствие объекта — ошибка. */
	read: (key: string) => Promise<Buffer>;
	/** Убирает объект: так проверяется поведение при пропавшем файле. */
	remove: (key: string) => Promise<void>;
	/** Убирает бакет файла тестов. Второй вызов ничего не делает. */
	stop: () => Promise<void>;
};

/**
 * SeaweedFS на весь прогон — с теми же ключами запуска, что в
 * `docker-compose.yml`. Бакетов не заводит — их заводят файлы тестов.
 */
export async function startStorageServer(): Promise<{
	server: StorageServer;
	stop: () => Promise<void>;
}> {
	const container = await new GenericContainer(IMAGE)
		.withCommand([
			'server',
			'-s3',
			'-ip.bind=0.0.0.0',
			'-master.telemetry=false',
			'-s3.autoCreateBucket=false',
			'-s3.port.iceberg=0',
			'-s3.port.lance=0'
		])
		.withEnvironment({ AWS_ACCESS_KEY_ID: ACCESS_KEY, AWS_SECRET_ACCESS_KEY: SECRET_KEY })
		.withExposedPorts(S3_PORT)
		// Готовность — та же, что у compose: мастер, сервер томов и шлюз вместе.
		// Шлюз сам по себе отвечает раньше, чем мастер выбран, и первое чтение
		// в этом окне падает с 500.
		.withHealthCheck({
			test: [
				'CMD-SHELL',
				'curl -sf http://127.0.0.1:9333/cluster/healthz && curl -sf http://127.0.0.1:8080/healthz && curl -sf http://127.0.0.1:8333/healthz'
			],
			interval: 1_000,
			timeout: 3_000,
			retries: 120
		})
		.withWaitStrategy(Wait.forHealthCheck())
		.start();

	return {
		server: {
			endpoint: `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`,
			region: REGION,
			accessKey: ACCESS_KEY,
			secretKey: SECRET_KEY
		},
		stop: async () => {
			await container.stop();
		}
	};
}

export async function startTestStorage({
	server
}: {
	server: StorageServer;
}): Promise<TestStorage> {
	// Свой бакет на файл тестов: имя короткое и из разрешённых знаков —
	// `S3_BUCKET` приложение проверяет регулярным выражением.
	const bucket = `lct-test-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

	const client = new S3Client({
		endpoint: server.endpoint,
		region: server.region,
		forcePathStyle: true,
		credentials: { accessKeyId: server.accessKey, secretAccessKey: server.secretKey }
	});

	// Бакет заводит установка, а не приложение: на стенде это делает `seaweedfs-init`
	// из compose, здесь — эта строка.
	await client.send(new CreateBucketCommand({ Bucket: bucket }));

	let stopped = false;

	const keys = async (prefix: string): Promise<string[]> => {
		const found: string[] = [];
		let token: string | undefined;

		do {
			const page = await client.send(
				new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
			);

			for (const object of page.Contents ?? []) {
				if (object.Key !== undefined) {
					found.push(object.Key);
				}
			}

			token = page.NextContinuationToken;
		} while (token !== undefined);

		return found.sort();
	};

	/**
	 * Убирает бакет целиком. Пустой бакет S3 удалить даёт, непустой — нет,
	 * поэтому сначала уходят объекты. Отказ уборки не должен ронять прогон:
	 * хранилище всё равно умрёт вместе с контейнером в конце.
	 */
	const dropBucket = async (): Promise<void> => {
		try {
			const objects = await keys('');

			for (let from = 0; from < objects.length; from += 1000) {
				await client.send(
					new DeleteObjectsCommand({
						Bucket: bucket,
						Delete: { Objects: objects.slice(from, from + 1000).map((Key) => ({ Key })) }
					})
				);
			}

			await client.send(new DeleteBucketCommand({ Bucket: bucket }));
		} catch {
			// Намеренно молча: см. комментарий выше.
		}
	};

	return {
		env: {
			S3_ENDPOINT: server.endpoint,
			S3_REGION: server.region,
			S3_BUCKET: bucket,
			S3_ACCESS_KEY: server.accessKey,
			S3_SECRET_KEY: server.secretKey,
			S3_FORCE_PATH_STYLE: 'true'
		},
		keys,
		read: async (key) => {
			const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

			if (response.Body === undefined) {
				throw new Error(`Объект «${key}» пришёл без содержимого`);
			}

			return Buffer.from(await response.Body.transformToByteArray());
		},
		remove: async (key) => {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		},
		stop: async () => {
			if (stopped) {
				return;
			}

			stopped = true;

			await dropBucket();

			client.destroy();
		}
	};
}
