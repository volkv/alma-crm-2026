/**
 * Настоящее хранилище файлов для интеграционных тестов.
 *
 * MinIO поднимается один раз на прогон (`global-setup.ts`), а файл тестов
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
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';

/** Тот же образ, что в `docker-compose.yml`: тесты и стенд ходят в одну версию. */
const IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';

const REGION = 'us-east-1';
const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key';

/** Координаты поднятого MinIO: по ним заводится бакет файла тестов. */
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

/** MinIO на весь прогон. Бакетов не заводит — их заводят файлы тестов. */
export async function startStorageServer(): Promise<{
	server: StorageServer;
	stop: () => Promise<void>;
}> {
	const container: StartedMinioContainer = await new MinioContainer(IMAGE)
		.withUsername(ACCESS_KEY)
		.withPassword(SECRET_KEY)
		.start();

	return {
		server: {
			endpoint: container.getConnectionUrl(),
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

	// Бакет заводит установка, а не приложение: на стенде это делает `minio-init`
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
