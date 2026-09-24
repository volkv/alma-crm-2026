/**
 * Настройки демонстрационного стенда.
 *
 * Внешние источники по умолчанию выключены (`SETTING_DEFAULTS`): установка
 * заказчика включает их осознанно. Демонстрационному стенду они нужны сразу —
 * паспорт организации показывают на вузах с настоящими сайтами
 * (`scripts/seed/directory.ts`), и без флага кнопка ответила бы только
 * «выключено в настройках».
 *
 * Строка заводится, только если её ещё нет: сид не затирает то, что
 * администратор стенда поменял руками, — ни при повторном запуске, ни при
 * ночном сбросе, который настройки не стирает.
 */
import { settingSchemas, type SettingValue } from '$lib/contracts/settings';
import { appSettings } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';

/**
 * Квота на сотрудника в сутки. Демонстрационные учётные записи общие на всех
 * посетителей, поэтому умолчание в 50 обращений кончилось бы за один день
 * показов; тысяча — потолок настройки, двести — запас на день без него.
 */
const DEMO_ENRICHMENT: SettingValue<'enrichment'> = settingSchemas.enrichment.parse({
	enabled: true,
	dailyQuota: 200
});

export async function seedSettings(tx: Tx): Promise<void> {
	await tx
		.insert(appSettings)
		.values({ key: 'enrichment', value: DEMO_ENRICHMENT })
		.onConflictDoNothing({ target: appSettings.key });
}
