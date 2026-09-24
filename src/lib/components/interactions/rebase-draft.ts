/**
 * Черновик формы после «Обновить карточку»: поле, которое человек не трогал,
 * берётся из свежей записи, тронутое остаётся его.
 *
 * Без этого повторное сохранение вернуло бы в нетронутые поля то, что было при
 * открытии диалога, — ровно ту перезапись чужой правки, о которой предупредил
 * отказ. Сравнение — по значению: списки позиций приходят новыми массивами.
 */
export function rebaseDraft<TDraft extends Record<string, unknown>>(
	base: TDraft,
	draft: TDraft,
	fresh: TDraft
): TDraft {
	const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
	const result = { ...draft };

	for (const key of Object.keys(fresh) as (keyof TDraft)[]) {
		if (same(draft[key], base[key])) {
			result[key] = fresh[key];
		}
	}

	return result;
}
