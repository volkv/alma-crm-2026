/**
 * Нарушение уникальности — в понятную фразу.
 *
 * Уникальность справочника держит база, а не сервис: две вкладки и две
 * загрузки одного файла — обычное дело, и проверка «а нет ли уже такой записи»
 * перед вставкой ничего не гарантирует. Поэтому запись идёт как есть, а
 * нарушение ограничения переводится здесь — один словарь на весь справочник,
 * чтобы гонка показывала человеку объяснение, а не код PostgreSQL.
 */
import { ConflictError } from '../errors';

const UNIQUE_VIOLATION = '23505';

/**
 * Что человек должен прочитать вместо кода ограничения. Словарь закрыт: новое
 * ограничение уникальности заводится вместе со строкой отсюда, иначе гонка
 * покажет пятисотую вместо объяснения.
 */
const CONFLICT_BY_CONSTRAINT: Record<string, string> = {
	directions_code_key: 'Направление с таким кодом уже заведено',
	directions_position_key: 'Позиция направления уже занята: повторите попытку',
	organizations_inn_key: 'Организация с таким ИНН уже заведена',
	organizations_external_ref_key: 'Эта запись внешней системы уже связана с другой организацией',
	sites_organization_name_key: 'У организации уже есть площадка с таким названием',
	sites_external_ref_key: 'Эта запись внешней системы уже связана с другой площадкой',
	programs_code_unique: 'Программа с таким кодом уже заведена',
	programs_external_ref_key: 'Эта запись внешней системы уже связана с другой программой',
	program_versions_program_version_key: 'Такая версия программы уже создана',
	products_code_unique: 'Продукт с таким кодом уже заведён',
	products_external_ref_key: 'Эта запись внешней системы уже связана с другим продуктом',
	contracts_organization_number_key: 'У этого контрагента уже есть договор с таким номером',
	contract_items_contract_product_key: 'В этом договоре уже есть позиция по этому продукту'
};

/** Имя нарушенного ограничения уникальности, если запрос упал именно на нём. */
function uniqueViolation(error: unknown): string | undefined {
	let current: unknown = error;

	while (current instanceof Error) {
		const candidate = current as { code?: unknown; constraint_name?: unknown };
		if (candidate.code === UNIQUE_VIOLATION && typeof candidate.constraint_name === 'string') {
			return candidate.constraint_name;
		}
		current = current.cause;
	}

	return undefined;
}

/**
 * Нарушение уникальности — это конфликт состояний, а не сбой: запись успела
 * появиться в соседней вкладке. Всё остальное летит дальше нетронутым.
 */
export async function withUniqueConflicts<TResult>(run: () => Promise<TResult>): Promise<TResult> {
	try {
		return await run();
	} catch (error) {
		const constraint = uniqueViolation(error);
		const message = constraint === undefined ? undefined : CONFLICT_BY_CONSTRAINT[constraint];

		if (message === undefined) {
			throw error;
		}

		throw new ConflictError(message);
	}
}
