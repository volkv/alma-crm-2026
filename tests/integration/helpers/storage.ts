/**
 * Настоящее хранилище файлов для интеграционных тестов.
 *
 * MinIO поднимается контейнером на файл тестов — по той же причине, по какой
 * так подняты PostgreSQL и Redis: прогон не должен ни зависеть от того, что
 * оставил предыдущий, ни мешать соседнему. Заглушка здесь не годится совсем:
 * проверяется ровно то, как ведёт себя S3 — отсутствующий объект, повторная
 * запись, чтение потоком, — и подделка проверяла бы подделку.
 *
 * Свой клиент, а не тот, которым ходит приложение: проверка должна смотреть на
 * хранилище со стороны, иначе сломанный код хранилища подтвердил бы сам себя.
 */
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	S3Client
} from '@aws-sdk/client-s3';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';

/** Тот же образ, что в `docker-compose.yml`: тесты и стенд ходят в одну версию. */
const IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';

const BUCKET = 'lct-documents-test';
const REGION = 'us-east-1';
const ACCESS_KEY = 'test-access-key';
const SECRET_KEY = 'test-secret-key';

export type TestStorage = {
	/** Переменные окружения, которыми сервисы находят это хранилище. */
	env: Readonly<Record<string, string>>;
	/** Ключи объектов под префиксом, по возрастанию. */
	keys: (prefix: string) => Promise<string[]>;
	/** Содержимое объекта; отсутствие объекта — ошибка. */
	read: (key: string) => Promise<Buffer>;
	/** Убирает объект: так проверяется поведение при пропавшем файле. */
	remove: (key: string) => Promise<void>;
	/**
	 * Гасит хранилище. Второй вызов ничего не делает: остановка — это ещё и
	 * способ показать коду недоступное хранилище, поэтому её зовут и из теста, и
	 * из уборки за прогоном.
	 */
	stop: () => Promise<void>;
};

export async function startTestStorage(): Promise<TestStorage> {
	const container: StartedMinioContainer = await new MinioContainer(IMAGE)
		.withUsername(ACCESS_KEY)
		.withPassword(SECRET_KEY)
		.start();

	const endpoint = container.getConnectionUrl();
	const client = new S3Client({
		endpoint,
		region: REGION,
		forcePathStyle: true,
		credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
	});

	// Бакет заводит установка, а не приложение: на стенде это делает `minio-init`
	// из compose, здесь — эта строка.
	await client.send(new CreateBucketCommand({ Bucket: BUCKET }));

	let stopped = false;

	return {
		env: {
			S3_ENDPOINT: endpoint,
			S3_REGION: REGION,
			S3_BUCKET: BUCKET,
			S3_ACCESS_KEY: ACCESS_KEY,
			S3_SECRET_KEY: SECRET_KEY,
			S3_FORCE_PATH_STYLE: 'true'
		},
		keys: async (prefix) => {
			const keys: string[] = [];
			let token: string | undefined;

			do {
				const page = await client.send(
					new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
				);

				for (const object of page.Contents ?? []) {
					if (object.Key !== undefined) {
						keys.push(object.Key);
					}
				}

				token = page.NextContinuationToken;
			} while (token !== undefined);

			return keys.sort();
		},
		read: async (key) => {
			const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));

			if (response.Body === undefined) {
				throw new Error(`Объект «${key}» пришёл без содержимого`);
			}

			return Buffer.from(await response.Body.transformToByteArray());
		},
		remove: async (key) => {
			await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
		},
		stop: async () => {
			if (stopped) {
				return;
			}

			stopped = true;
			client.destroy();
			await container.stop();
		}
	};
}
