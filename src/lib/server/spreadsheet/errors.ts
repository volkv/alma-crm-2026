/**
 * Отказы разбора и сборки таблиц.
 *
 * Наружу это обычная `ValidationError`: файл принёс человек, и по коду
 * `validation` транспорт уже отвечает 400 и показывает сообщение. Своё поле
 * `problem` нужно тем, кто решает, что делать дальше: «пустой файл» — это
 * «пришлите ещё раз», а «не распознан формат» — «сохраните как XLSX».
 * Разбирать русский текст сообщения ради этого никто не должен.
 */
import { ValidationError } from '../errors';

/** Из-за чего файл не стал таблицей. */
export type SpreadsheetProblem =
	/** В файле ноль байт. */
	| 'empty'
	/** Ни книга, ни текст: подпись файла не узнана. */
	| 'unknown_format'
	/** Формат узнан, но содержимое разобрать не удалось. */
	| 'unreadable'
	/** Книга прочиталась, но листов в ней нет. */
	| 'no_sheets'
	/** Текст не укладывается в кодировку, которую просили при выгрузке. */
	| 'encoding'
	/** Значение или имя листа, которое формат файла не может унести. */
	| 'unsupported_value';

export class SpreadsheetError extends ValidationError {
	readonly problem: SpreadsheetProblem;

	constructor(problem: SpreadsheetProblem, message: string, issues: readonly string[] = []) {
		super(message, issues);
		this.problem = problem;
	}
}
