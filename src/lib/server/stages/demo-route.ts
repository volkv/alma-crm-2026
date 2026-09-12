/**
 * Маршрут стадий, с которым система приезжает к заказчику.
 *
 * Это конфигурация, а не код: четырнадцать стадий процесса работы с учебным
 * заведением, нормативы в днях, чек-листы и переходы между стадиями. Всё, что
 * движок умеет, описано здесь данными — маршрут заказчика будет отличаться
 * значениями, а не устройством.
 *
 * Ключи стадий стабильны: по ним отметки чек-листа переживают переиздание
 * маршрута, и по ним же тесты и сиды находят нужную стадию. Названия стадий и
 * их смысловые группы — разные вещи: группа говорит, на каком участке процесса
 * мы стоим («документы», «обучение»), название — что именно делаем.
 */
import type {
	ChecklistItem,
	CreateRouteInput,
	StageTransitionDefinitionInput
} from '$lib/contracts/interactions';
import type { PermissionKey } from '../rbac/permissions';

/** Ключ маршрута. Версии одного маршрута делят его и различаются номером. */
export const DEMO_ROUTE_KEY = 'university-partnership';

/** Право, без которого движение по маршруту недоступно. */
const TRANSITION_PERMISSION: PermissionKey = 'stages.transition';

function item(key: string, label: string, required: boolean): ChecklistItem {
	return { key, label, required };
}

/** Шаг вперёд по цепочке: причина не нужна, процесс идёт своим ходом. */
function forward(fromStageKey: string, toStageKey: string): StageTransitionDefinitionInput {
	return {
		fromStageKey,
		toStageKey,
		kind: 'forward',
		requiredPermissionKey: TRANSITION_PERMISSION,
		requiresReason: false
	};
}

/** Возврат на предыдущую стадию: всегда с объяснением, что пошло не так. */
function back(fromStageKey: string, toStageKey: string): StageTransitionDefinitionInput {
	return {
		fromStageKey,
		toStageKey,
		kind: 'return',
		requiredPermissionKey: TRANSITION_PERMISSION,
		requiresReason: true
	};
}

/** Пропуск промежуточной стадии: тоже с объяснением — это отступление от плана. */
function skip(fromStageKey: string, toStageKey: string): StageTransitionDefinitionInput {
	return {
		fromStageKey,
		toStageKey,
		kind: 'skip',
		requiredPermissionKey: TRANSITION_PERMISSION,
		requiresReason: true
	};
}

/**
 * Порядок стадий задаётся порядком элементов массива: позиция — это индекс плюс
 * единица, отдельного поля с номером в конфигурации нет, чтобы номера не
 * разъехались с порядком при вставке стадии в середину.
 */
export const DEMO_ROUTE: CreateRouteInput = {
	key: DEMO_ROUTE_KEY,
	name: 'Взаимодействие с учебным заведением',
	description:
		'Полный цикл работы с вузом: от поиска контактов до контроля исполнения обязательств.',
	isDefault: true,
	stages: [
		{
			key: 'contact_search',
			name: 'Поиск контактных лиц',
			category: 'contact',
			slaDays: 7,
			staleAfterDays: 5,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('profile_unit_found', 'Найдено профильное подразделение', true),
				item('contact_confirmed', 'Подтверждён контакт ответственного лица', true),
				item('channel_agreed', 'Согласован канал связи', false)
			]
		},
		{
			key: 'communication',
			name: 'Коммуникация и сверка программ',
			category: 'contact',
			slaDays: 10,
			staleAfterDays: 7,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('offer_sent', 'Отправлено описание программ', true),
				item('needs_collected', 'Собраны потребности подразделения', false),
				item('programs_checked', 'Сверена актуальность программ', true)
			]
		},
		{
			key: 'meeting',
			name: 'Встреча с представителями',
			category: 'contact',
			slaDays: 14,
			staleAfterDays: 10,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('meeting_scheduled', 'Встреча назначена', true),
				item('participants_confirmed', 'Состав участников подтверждён', false),
				item('minutes_recorded', 'Зафиксированы договорённости', true)
			]
		},
		{
			key: 'document_exchange',
			name: 'Обмен пакетом документов',
			category: 'documents',
			slaDays: 10,
			staleAfterDays: 7,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('package_sent', 'Пакет документов отправлен', true),
				item('package_received', 'Получен ответный пакет', false),
				item('requisites_checked', 'Сверены реквизиты сторон', true)
			]
		},
		{
			key: 'document_revision',
			name: 'Корректировка документов',
			category: 'documents',
			slaDays: 7,
			staleAfterDays: 5,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('remarks_collected', 'Собраны замечания сторон', true),
				item('revision_agreed', 'Правки согласованы', true)
			]
		},
		{
			key: 'signing',
			name: 'Подписание соглашения',
			category: 'documents',
			slaDays: 14,
			staleAfterDays: 10,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('signatories_confirmed', 'Подтверждены подписанты сторон', true),
				item('signed_scan_received', 'Получен скан подписанного документа', true),
				item('original_filed', 'Оригинал передан на хранение', false)
			]
		},
		{
			key: 'materials_handover',
			name: 'Передача материалов и лицензий',
			category: 'delivery',
			slaDays: 10,
			staleAfterDays: 7,
			requiresResult: true,
			requiresConfirmation: true,
			checklist: [
				item('kit_prepared', 'Комплект материалов подготовлен', true),
				item('licenses_issued', 'Выданы лицензии на продукты', true),
				item('handover_act_signed', 'Подписан акт передачи', false)
			]
		},
		{
			key: 'implementation_support',
			name: 'Сопровождение внедрения',
			category: 'implementation',
			slaDays: 21,
			staleAfterDays: 14,
			requiresResult: true,
			requiresConfirmation: true,
			checklist: [
				item('rollout_plan_agreed', 'Согласован план внедрения', true),
				item('environment_ready', 'Развёрнута учебная среда', true),
				item('support_channel_open', 'Открыт канал технической поддержки', false)
			]
		},
		{
			key: 'teacher_training',
			name: 'Обучение преподавателей',
			category: 'training',
			slaDays: 30,
			staleAfterDays: 14,
			requiresResult: true,
			requiresConfirmation: true,
			checklist: [
				item('group_formed', 'Сформирована группа преподавателей', true),
				item('sessions_held', 'Занятия проведены', true),
				item('feedback_collected', 'Собрана обратная связь', false)
			]
		},
		{
			key: 'program_update',
			name: 'Актуализация образовательной программы',
			category: 'update',
			slaDays: 21,
			staleAfterDays: 14,
			requiresResult: true,
			requiresConfirmation: true,
			checklist: [
				item('gaps_identified', 'Выявлены расхождения с требованиями', true),
				item('changes_agreed', 'Изменения согласованы с учебным заведением', true),
				item('program_version_registered', 'Заведена новая версия программы', false)
			]
		},
		{
			key: 'classes',
			name: 'Ведение занятий',
			category: 'teaching',
			slaDays: 30,
			staleAfterDays: 21,
			requiresResult: true,
			requiresConfirmation: true,
			checklist: [
				item('schedule_published', 'Опубликовано расписание', true),
				item('attendance_tracked', 'Ведётся учёт посещаемости', true),
				item('midterm_review', 'Проведён промежуточный разбор', false)
			]
		},
		{
			key: 'documentation_update',
			name: 'Актуализация документации',
			category: 'update',
			slaDays: 14,
			staleAfterDays: 10,
			requiresResult: true,
			requiresConfirmation: false,
			checklist: [
				item('materials_revised', 'Обновлены учебные материалы', true),
				item('versions_published', 'Версии выложены в хранилище', true)
			]
		},
		{
			key: 'qualification_upgrade',
			name: 'Повышение квалификации',
			category: 'training',
			slaDays: 30,
			staleAfterDays: 21,
			requiresResult: true,
			requiresConfirmation: true,
			checklist: [
				item('course_selected', 'Подобрана программа повышения квалификации', true),
				item('participants_enrolled', 'Участники зачислены', true),
				item('certificates_issued', 'Выданы документы об обучении', false)
			]
		},
		{
			key: 'execution_control',
			name: 'Контроль исполнения',
			category: 'control',
			slaDays: 20,
			staleAfterDays: 14,
			requiresResult: false,
			requiresConfirmation: false,
			checklist: [
				item('report_collected', 'Собран отчёт по мероприятию', true),
				item('metrics_checked', 'Сверены плановые и фактические показатели', true),
				item('next_period_planned', 'Намечен следующий период', false)
			]
		}
	],
	transitions: [
		forward('contact_search', 'communication'),
		forward('communication', 'meeting'),
		forward('meeting', 'document_exchange'),
		forward('document_exchange', 'document_revision'),
		forward('document_revision', 'signing'),
		forward('signing', 'materials_handover'),
		forward('materials_handover', 'implementation_support'),
		forward('implementation_support', 'teacher_training'),
		forward('teacher_training', 'program_update'),
		forward('program_update', 'classes'),
		forward('classes', 'documentation_update'),
		forward('documentation_update', 'qualification_upgrade'),
		forward('qualification_upgrade', 'execution_control'),

		back('communication', 'contact_search'),
		back('meeting', 'communication'),
		back('document_exchange', 'meeting'),
		back('document_revision', 'document_exchange'),
		back('signing', 'document_revision'),
		back('materials_handover', 'signing'),
		back('implementation_support', 'materials_handover'),
		back('teacher_training', 'implementation_support'),
		back('program_update', 'teacher_training'),
		back('classes', 'program_update'),
		back('documentation_update', 'classes'),
		back('qualification_upgrade', 'documentation_update'),
		back('execution_control', 'qualification_upgrade'),

		// Корректировка документов нужна не всегда: если замечаний нет, с обмена
		// документами идут сразу на подписание. Пара «откуда — куда» уникальна,
		// поэтому пропуск описан именно перешагиванием, а не вторым переходом
		// между теми же стадиями.
		skip('document_exchange', 'signing')
	]
};
