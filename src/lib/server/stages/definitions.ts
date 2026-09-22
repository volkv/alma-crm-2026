/**
 * Процессы, с которыми система приезжает к заказчику.
 *
 * Это конфигурация, а не код: стадии с нормативами и чек-листами плюс переходы
 * между ними. Всё, что движок умеет, описано здесь данными — процесс заказчика
 * будет отличаться значениями, а не устройством, и меняется он на ходу
 * черновиком, а не правкой этого файла.
 *
 * Ключи стадий стабильны: по ним записи сопоставляются с новой структурой при
 * изменении процесса, по ним же отметки чек-листа переживают публикацию, и по
 * ним тесты и сиды находят нужную стадию. Названия стадий и их смысловые
 * группы — разные вещи: группа говорит, на каком участке процесса мы стоим
 * («документы», «обучение»), название — что именно делаем.
 */
import type {
	ChecklistItem,
	ProcessDefinitionInput,
	StageTransitionDefinitionInput
} from '$lib/contracts/interactions';
import type { PermissionKey } from '../rbac/permissions';

/** Ключ пространства, в котором идёт работа с учебными заведениями. */
export const B2B_WORKSPACE_KEY = 'b2b';

/** Ключ пространства физических и юридических лиц: короткий процесс обучения. */
export const B2C_WORKSPACE_KEY = 'b2c';

/**
 * Ключи процессов. Совпадают с ключами пространств, потому что до выделения
 * процесса место и работа были одним и тем же, и миграция завела процесс на
 * каждое пространство с его ключом. Совпадение это историческое: третий процесс
 * заводят под своим именем и назначают куда угодно.
 */
export const B2B_WORKFLOW_KEY = 'b2b';

export const B2C_WORKFLOW_KEY = 'b2c';

/** Право, без которого движение по процессу недоступно. */
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
export const B2B_PROCESS: ProcessDefinitionInput = {
	name: 'Взаимодействие с учебным заведением',
	note: 'Полный цикл работы с вузом: от поиска контактов до контроля исполнения обязательств.',
	migrationRules: [],
	stages: [
		{
			key: 'contact_search',
			name: 'Поиск контактных лиц',
			category: 'contact',
			slaDays: 7,
			staleAfterDays: 5,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			// Единственная стадия процесса, исполнение которой доказывает сам
			// документ: соглашение либо утверждено, либо нет, и отметка
			// ответственного «я подтверждаю» этого не заменяет. Отметка
			// «Утверждён» (`approved`) — та, что означает подписанный сторонами
			// экземпляр; «Введён в действие» наступает позже и по договору.
			requiresDocumentMark: 'approved',
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			// Единственная стадия процесса, исполнение которой доказывает чужая
			// система: занятия идут в системе обучения, и результат потока
			// оттуда — единственное свидетельство, которое не пишет о себе сам
			// исполнитель. Он же и подтверждает стадию — видом `lms_record`.
			requiresLmsData: true,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
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
			requiresLmsData: false,
			requiresDocumentMark: null,
			// Финальная стадия процесса: с неё взаимодействие завершают, а не идут
			// дальше, и перехода вперёд с неё не требуется.
			isFinal: true,
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

/**
 * Короткий процесс обучения физических и юридических лиц.
 *
 * Пять стадий вместо четырнадцати: у этого пространства нет ни своих экранов,
 * ни своих документов, а каждая стадия — это строка в сиде, колонка на доске и
 * случай в тестах. «Уточнение запроса» свёрнуто в приём заявки, «зачисление в поток» — в
 * обучение: оба были шагами без собственного доказательства исполнения.
 */
export const B2C_PROCESS: ProcessDefinitionInput = {
	name: 'Обучение физических и юридических лиц',
	note: 'Короткий процесс: заявка, предложение, договор и оплата, обучение, документ об обучении.',
	migrationRules: [],
	stages: [
		{
			key: 'lead_intake',
			name: 'Заявка принята',
			category: 'contact',
			slaDays: 3,
			staleAfterDays: 2,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
			checklist: [
				item('request_understood', 'Запрос понят и зафиксирован', true),
				item('owner_assigned', 'Назначен ответственный', true)
			]
		},
		{
			key: 'offer',
			name: 'Предложение и условия',
			category: 'documents',
			slaDays: 5,
			staleAfterDays: 3,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
			checklist: [
				item('program_selected', 'Подобрана программа обучения', true),
				item('offer_sent', 'Отправлены программа, стоимость и условия', true)
			]
		},
		{
			key: 'contract_payment',
			name: 'Договор и оплата',
			category: 'documents',
			slaDays: 10,
			staleAfterDays: 5,
			requiresResult: false,
			// Без подписи и оплаты зачисление не начинается, и доказательство
			// этому — файл, а не отметка «сделано».
			requiresConfirmation: true,
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: false,
			checklist: [
				item('contract_signed', 'Договор подписан', true),
				item('payment_received', 'Оплата получена', true)
			]
		},
		{
			key: 'learning',
			name: 'Зачисление и обучение',
			category: 'teaching',
			slaDays: 45,
			staleAfterDays: 21,
			requiresResult: true,
			requiresConfirmation: false,
			// То же, что «Ведение занятий» у учебных заведений: обучение идёт в
			// чужой системе, и закончилось оно или нет, знает она. Подтверждения
			// стадия не требует, поэтому факт обучения здесь — доказательство
			// исполнения, а не подпись под ним.
			requiresLmsData: true,
			requiresDocumentMark: null,
			isFinal: false,
			checklist: [
				item('enrolled', 'Слушатель зачислен в поток', true),
				item('classes_started', 'Занятия начаты', true)
			]
		},
		{
			key: 'completion',
			name: 'Завершение и документ об обучении',
			category: 'control',
			slaDays: 14,
			staleAfterDays: 10,
			requiresResult: true,
			requiresConfirmation: false,
			requiresLmsData: false,
			requiresDocumentMark: null,
			isFinal: true,
			checklist: [
				item('assessment_done', 'Итоговая аттестация проведена', true),
				item('document_issued', 'Выдан документ об обучении', true),
				item('feedback_collected', 'Собрана обратная связь', false)
			]
		}
	],
	transitions: [
		forward('lead_intake', 'offer'),
		forward('offer', 'contract_payment'),
		forward('contract_payment', 'learning'),
		forward('learning', 'completion'),

		back('offer', 'lead_intake'),
		back('contract_payment', 'offer'),
		back('learning', 'contract_payment'),
		back('completion', 'learning'),

		// Повторному слушателю, чей запрос уже известен, предложение не нужно:
		// с приёма заявки идут сразу к договору.
		skip('lead_intake', 'contract_payment')
	]
};
