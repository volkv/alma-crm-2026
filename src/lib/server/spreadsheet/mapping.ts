/**
 * Сопоставление колонок файла с полями строки — правило, общее для всех
 * импортов.
 *
 * Выгрузки приходят из разных систем, и одна и та же величина называется в них
 * по-разному: «Подано заявок», «Заявки», «applications»; «Название ВУЗа»,
 * «Вуз», «Учебное заведение». Словарь синонимов у каждого импорта свой, а
 * правило выбора — одно, и живёт оно здесь: два одинаковых «почти» алгоритма
 * разошлись бы на первой же правке, и разошлись бы молча — в том, какая колонка
 * во что попала.
 *
 * Сопоставление **предлагается**, а решает человек. Предложение, которое нельзя
 * отменить в интерфейсе, было бы хуже отсутствия предложения: ошибку такого
 * сопоставления потом не найти.
 */

/**
 * Название колонки в сравнимом виде: регистр, «ё», знаки препинания и лишние
 * пробелы к делу не относятся — «Охват, план» и «охват план» это одна колонка.
 */
export function normalizeHeader(header: string): string {
	return header
		.toLocaleLowerCase('ru')
		.replaceAll('ё', 'е')
		.replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** Словарь синонимов: поле → как его называют в файлах. */
export type FieldSynonyms<TField extends string> = Record<TField, readonly string[]>;

/** Совпадение колонки с полем и то, насколько оно уверенное. */
type Match<TField extends string> = {
	column: string;
	field: TField;
	/** Точное совпадение сильнее вхождения, длинный синоним — сильнее короткого. */
	score: number;
	exact: boolean;
};

function matchesFor<TField extends string>(
	column: string,
	fields: readonly TField[],
	synonyms: FieldSynonyms<TField>
): Match<TField>[] {
	const normalized = normalizeHeader(column);
	const matches: Match<TField>[] = [];

	if (normalized === '') {
		return matches;
	}

	for (const field of fields) {
		let best: Match<TField> | null = null;

		for (const synonym of synonyms[field]) {
			const exact = normalized === synonym;
			const hit = exact || normalized.includes(synonym);

			if (!hit) {
				continue;
			}

			const score = (exact ? 1000 : 0) + synonym.length;

			if (best === null || score > best.score) {
				best = { column, field, score, exact };
			}
		}

		if (best !== null) {
			matches.push(best);
		}
	}

	return matches;
}

/**
 * Предложенное сопоставление: колонка → поле.
 *
 * Одно поле достаётся одной колонке: в выгрузке рядом стоят «Охват, план» и
 * «Охват, факт», и если бы поле могло достаться обеим, предложение зависело бы
 * от порядка колонок. Поэтому совпадения разбираются от самого уверенного к
 * самому слабому, и занятые колонка и поле больше не участвуют.
 */
export function suggestFieldMapping<TField extends string>(
	headers: readonly string[],
	fields: readonly TField[],
	synonyms: FieldSynonyms<TField>
): Record<string, TField> {
	const matches = headers
		.flatMap((header) => matchesFor(header, fields, synonyms))
		// Порядок колонок в файле — последний ключ: без него два одинаково
		// уверенных совпадения менялись бы местами от запуска к запуску.
		.sort(
			(left, right) =>
				right.score - left.score || headers.indexOf(left.column) - headers.indexOf(right.column)
		);

	const mapping: Record<string, TField> = {};
	const takenFields = new Set<TField>();

	for (const match of matches) {
		if (takenFields.has(match.field) || match.column in mapping) {
			continue;
		}

		mapping[match.column] = match.field;
		takenFields.add(match.field);
	}

	return mapping;
}

/** Насколько уверенно колонка сопоставлена: показывается рядом с предложением. */
export function fieldMappingConfidence<TField extends string>(
	column: string,
	field: TField,
	fields: readonly TField[],
	synonyms: FieldSynonyms<TField>
): number {
	const match = matchesFor(column, fields, synonyms).find((candidate) => candidate.field === field);

	if (match === undefined) {
		return 0;
	}

	return match.exact ? 1 : 0.6;
}
