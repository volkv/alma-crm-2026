/**
 * Подсказка по сопоставлению колонок.
 *
 * Это тот самый шов, за которым может стоять языковая модель: интерфейс
 * описан здесь, а реализация в поставке — правила по словарю синонимов
 * (`mapping.ts`). Второго поставщика в продукте нет намеренно: основной
 * процесс обязан работать без сети и без модели, а подсказка, без которой
 * импорт не идёт, — это уже не подсказка.
 *
 * Что бы ни предложил советчик, сопоставление применяет человек: ответ
 * советчика едет в интерфейс как предложение с пометкой «предложено», а в
 * базу попадает то, что человек подтвердил.
 */
import type { MappingAdvice, MappingRequest } from '$lib/contracts/stats';
import { mappingConfidence, suggestMapping } from './mapping';

export interface MappingAdvisor {
	/** Чем подсказка получена: попадает в интерфейс рядом с предложением. */
	readonly kind: 'mock';
	suggest(request: MappingRequest): Promise<MappingAdvice[]>;
}

/**
 * Советчик по правилам: словарь синонимов и ничего больше. Строки файла он не
 * смотрит — они есть в запросе ради поставщика, который будет смотреть.
 */
export const ruleBasedAdvisor: MappingAdvisor = {
	kind: 'mock',

	async suggest(request: MappingRequest): Promise<MappingAdvice[]> {
		const mapping = suggestMapping(request.headers);

		return request.headers.map((column) => {
			const field = mapping[column] ?? null;

			return {
				column,
				field,
				confidence: field === null ? 0 : mappingConfidence(column, field),
				reason:
					field === null
						? 'Название колонки не похоже ни на одно известное поле'
						: 'Название колонки совпало со словарём синонимов'
			};
		});
	}
};

/** Советчик, которым пользуется импорт. */
export function getMappingAdvisor(): MappingAdvisor {
	return ruleBasedAdvisor;
}
