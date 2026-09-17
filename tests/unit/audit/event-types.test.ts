/**
 * Словарь журнала против кода, который его пишет.
 *
 * Событие из словаря видно пользователю: оно стоит в фильтре журнала и в списке
 * подписок на вебхуки. Код, который никто не эмитит, — это обещание события,
 * которого не будет: администратор подписывает вебхук и не может отличить «не
 * настроилось» от «не бывает». Подсистему удаляют вместе с её событиями, и
 * страж следит ровно за этим — чтобы словарь не пережил тот код, ради которого
 * он заведён.
 *
 * Проверка идёт по тексту файлов, а не по импортам: событие пишется литералом
 * (`type: 'interactions.created'`), и статического потребителя у самой строки
 * нет. Словарь и таблица подписей из просмотра исключены — в них код и так
 * стоит по определению.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_TYPES } from '$lib/contracts/audit';
import { auditEventLabel } from '../../../src/routes/(app)/audit/labels';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

/** Где код события стоит по определению, а не потому, что его записывают. */
const DICTIONARY_FILES = ['lib/contracts/audit.ts', 'routes/(app)/audit/labels.ts'].map(
	(relative) => `${SRC}${relative}`
);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}${entry.name}`;

		if (entry.isDirectory()) {
			return sourceFiles(`${path}/`);
		}

		return /\.(ts|svelte)$/.test(entry.name) && !DICTIONARY_FILES.includes(path) ? [path] : [];
	});
}

describe('словарь журнала действий', () => {
	it('не держит событий, которых код не пишет', () => {
		const files = sourceFiles(SRC);
		expect(files.length).toBeGreaterThan(0);

		const sources = files.map((path) => readFileSync(path, 'utf8')).join('\n');
		const unused = AUDIT_EVENT_TYPES.filter((type) => !sources.includes(`'${type}'`));

		expect(unused).toEqual([]);
	});

	it('показывает код события, которого в нём уже нет', () => {
		// Журнал неизменяем: строки удалённых подсистем остаются в базе навсегда,
		// и на экране у них обязано стоять хоть что-то — код, раз названия больше
		// нет. Пустая ячейка вместо события выглядела бы поломкой журнала.
		expect(auditEventLabel('stages.route_published')).toBe('stages.route_published');
		expect(auditEventLabel('auth.login')).toBe('Вход в систему');
	});
});
