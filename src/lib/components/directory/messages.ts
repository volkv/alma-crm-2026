import type { ResolvedPathname } from '$app/types';
import type { LookupOption } from '$lib/contracts/directory';

/**
 * Сообщение, которым действие формы отвечает на отказ.
 *
 * Одна фраза человеку и, если отказ упирается в уже существующую запись,
 * ссылка на неё: «ИНН занят» без ответа «кем именно» заставляет искать дубль
 * руками, а он уже найден — на нём и споткнулись.
 */
export type DirectoryMessage = {
	text: string;
	/** Запись, из-за которой действие не прошло. */
	conflictsWith?: LookupOption;
	/** Куда ведёт ссылка на неё. */
	conflictHref?: ResolvedPathname;
	/**
	 * Похожие записи, из-за которых действие остановилось на вопрос, а не на
	 * отказ: форму можно отправить ещё раз с подтверждением.
	 */
	duplicates?: { label: string; href: ResolvedPathname; reason: string }[];
};
