/**
 * Какие группы меню свёрнуты и что считать нормой, пока человек ничего не решал.
 *
 * Отдельный файл без рун и без импортов сборки: правило по умолчанию читают и
 * состояние панели, и модульная проверка, а проверке ни браузер, ни контекст
 * компонента не нужны.
 */

/** Где лежат решения человека: одна запись на установку, не на вкладку. */
export const NAV_GROUPS_STORAGE_KEY = 'lct-crm:nav-groups';

/**
 * Группы, свёрнутые до первого решения человека. «Настройки» — правила, по
 * которым система работает: их заводят однажды, а меню они занимали больше
 * всех, отжимая ежедневную работу за край экрана.
 */
const COLLAPSED_BY_DEFAULT: ReadonlySet<string> = new Set(['settings']);

/** Решения человека: ключ группы → свёрнута ли она. Группы без записи — по умолчанию. */
export type NavGroupChoices = Readonly<Record<string, boolean>>;

/**
 * Разбирает запись из браузера. Чужое или испорченное содержимое — не повод
 * оставить человека без меню: непонятное отбрасывается молча, и группы встают
 * так, как встали бы на чистой установке.
 */
export function parseNavGroups(raw: string | null): NavGroupChoices {
	if (raw === null) {
		return {};
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {};
	}

	const choices: Record<string, boolean> = {};

	for (const [id, value] of Object.entries(parsed)) {
		if (typeof value === 'boolean') {
			choices[id] = value;
		}
	}

	return choices;
}

/**
 * Свёрнута ли группа. Решение человека сильнее всего остального: он сам
 * закрыл — значит закрыто, даже если открытая страница внутри.
 *
 * Пока решения нет, группа по умолчанию свёрнутая всё-таки открывается, когда
 * держит текущую страницу: меню, в котором не видно, где ты стоишь, отвечает не
 * на тот вопрос, с которым в него смотрят.
 */
export function navGroupCollapsed(
	choices: NavGroupChoices,
	groupId: string,
	holdsActive: boolean
): boolean {
	const choice = choices[groupId];

	if (choice !== undefined) {
		return choice;
	}

	return COLLAPSED_BY_DEFAULT.has(groupId) && !holdsActive;
}
