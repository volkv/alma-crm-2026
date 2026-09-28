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
import type { ChecklistRuleKey } from '$lib/platform/checklist-rules';
import type { PermissionKey } from '../rbac/permissions';

/** Ключ пространства, в котором идёт работа с учебными заведениями. */
export const B2B_WORKSPACE_KEY = 'b2b';

/** Ключ пространства коммерческого обучения: короткий процесс обучения лиц. */
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

/**
 * Пункт чек-листа. Пояснение обязательно у каждого пункта поставки: «галочка
 * без объяснения» не говорит, что значит сделать. Пункт-факт (`fact`)
 * закрывают данные дела по правилу каталога, отметка его не заменяет;
 * действие (`action`) — кнопка рядом, открывающая форму, где делают работу.
 */
function item(
	key: string,
	label: string,
	required: boolean,
	options: { help: string; fact?: ChecklistRuleKey; action?: string }
): ChecklistItem {
	return {
		key,
		label,
		required,
		help: options.help,
		completion:
			options.fact === undefined ? { kind: 'manual' } : { kind: 'fact', rule: options.fact },
		...(options.action === undefined ? {} : { action: options.action })
	};
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
	name: 'Работа с ВУЗ',
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('profile_unit_found', 'Найдено профильное подразделение', true, {
					help: 'Выберите у стороны площадку вида «Подразделение» — кафедру или институт, с которым идёт работа. Выбирают в диалоге «Стороны» карточки (кнопка «Сменить» у стороны); нет такой площадки — там же добавьте её в «Добавить площадку» с видом «Подразделение». Пункт закроется сам.',
					fact: 'party_department',
					action: 'party'
				}),
				item('contact_confirmed', 'Подтверждён контакт ответственного лица', true, {
					help: 'Укажите у стороны контактное лицо с его ролью и отметьте, когда он подтвердил, что ведёт работу с нами. Просто заведённого человека для этого мало.',
					action: 'contact'
				}),
				item('channel_agreed', 'Согласован канал связи', false, {
					help: 'В диалоге контактного лица заполните «Как связываться» — почта, телефон, мессенджер или портал, как договорились. Пункт закроется сам.',
					fact: 'contact_channel',
					action: 'contact'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('offer_sent', 'Отправлено описание программ', true, {
					help: 'Отметьте, когда описание программ ушло вузу. Приложите отправленный файл — будет видно, что именно отправили.',
					action: 'upload'
				}),
				item('needs_collected', 'Собраны потребности подразделения', false, {
					help: 'Запишите потребности подразделения комментарием в ленте или приложите файл, затем отметьте.',
					action: 'upload'
				}),
				item('programs_checked', 'Сверена актуальность программ', true, {
					help: 'Сверьте программы и их версии в составе дела с тем, что нужно вузу; расхождения запишите комментарием и отметьте.'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('meeting_scheduled', 'Встреча назначена', true, {
					help: 'Назначьте встречу кнопкой: дата и место сохранятся в деле, участникам уйдёт файл для календаря. Отметьте, когда время согласовано с вузом.',
					action: 'meetings:invite'
				}),
				item('participants_confirmed', 'Состав участников подтверждён', false, {
					help: 'Отметьте, когда участники со стороны вуза подтвердили, что придут. Состав — в приглашении.',
					action: 'meetings:invite'
				}),
				item('minutes_recorded', 'Зафиксированы договорённости', true, {
					help: 'Запишите итог встречи результатом стадии — пункт закроется сам.',
					fact: 'stage_result',
					action: 'result'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('package_sent', 'Пакет документов отправлен', true, {
					help: 'Соберите пакет по шаблонам, отправьте вузу и отметьте.',
					action: 'package'
				}),
				item('package_received', 'Получен ответный пакет', false, {
					help: 'Загрузите ответные документы вуза в карточку и отметьте.',
					action: 'upload'
				}),
				item('requisites_checked', 'Сверены реквизиты сторон', true, {
					help: 'Сверьте реквизиты в пакете с карточками организаций сторон и отметьте. Ошибку исправляют в справочнике.',
					action: 'party'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('remarks_collected', 'Собраны замечания сторон', true, {
					help: 'Приложите замечания сторон файлом или запишите комментарием и отметьте.',
					action: 'upload'
				}),
				item('revision_agreed', 'Правки согласованы', true, {
					help: 'Загрузите согласованную редакцию и отметьте, когда стороны подтвердили правки: загрузка сама согласования не доказывает.',
					action: 'upload'
				})
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
			// Исполнение стадии доказывает сам документ: соглашение либо
			// утверждено, либо нет, и отметка ответственного «я подтверждаю» этого
			// не заменяет. Шаблон не сужен: подписанный экземпляр соглашения
			// обычно загружают сканом, а не собирают по шаблону. Отметка
			// «Утверждён» (`approved`) — та, что означает подписанный сторонами
			// экземпляр; «Введён в действие» наступает позже и по договору.
			requiresDocumentMark: 'approved',
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			// Соглашение — поворотная точка работы с вузом: руководитель узнаёт,
			// что дело дошло до подписания, не дожидаясь утренней сводки.
			onEnterNotify: 'manager',
			isFinal: false,
			checklist: [
				item('signatories_confirmed', 'Подтверждены подписанты сторон', true, {
					help: 'Отметьте, когда подписанты сторон и их полномочия подтверждены. Подписанты — у контактов стороны.',
					action: 'party'
				}),
				item('signed_scan_received', 'Получен скан подписанного документа', true, {
					help: 'Загрузите скан подписанного соглашения и отметьте.',
					action: 'upload'
				}),
				item('original_filed', 'Оригинал передан на хранение', false, {
					help: 'Отметьте, когда оригинал передан на хранение; где он лежит, запишите комментарием.'
				})
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
			// Факт передачи — подписанный акт, а не слово исполнителя: стадию
			// закрывает отметка «Утверждён» на акте передачи, и той же отметкой
			// позиции договора из акта получают статус «передан». Шаблон
			// обязателен: без него стадию сразу при входе закрыло бы соглашение,
			// утверждённое на подписании.
			requiresDocumentMark: 'approved',
			requiresDocumentTemplate: 'handover_act',
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('kit_prepared', 'Комплект материалов подготовлен', true, {
					help: 'Перечислите состав комплекта в результате стадии и отметьте.',
					action: 'result'
				}),
				item('licenses_issued', 'Выданы лицензии на продукты', true, {
					help: 'Выберите в деле позицию договора по каждому продукту и укажите у неё дату оформления лицензии — пункт закроется сам. У дела без продуктов он закрыт: лицензировать нечего.',
					fact: 'licenses_issued',
					action: 'contract'
				}),
				item('handover_act_signed', 'Подписан акт передачи', false, {
					help: 'Соберите акт передачи по шаблону, загрузите подписанный скан новой редакцией и отметьте «Утверждён» — пункт закроется сам.',
					fact: 'handover_act_approved',
					action: 'mark'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('rollout_plan_agreed', 'Согласован план внедрения', true, {
					help: 'Приложите согласованный план внедрения и отметьте.',
					action: 'upload'
				}),
				item('environment_ready', 'Развёрнута учебная среда', true, {
					help: 'Запишите адрес учебной среды в результате стадии и отметьте, когда она развёрнута.',
					action: 'result'
				}),
				item('support_channel_open', 'Открыт канал технической поддержки', false, {
					help: 'Запишите комментарием адрес поддержки и ответственного и отметьте.'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('group_formed', 'Сформирована группа преподавателей', true, {
					help: 'Заявите поток с назначением «Обучение преподавателей» и загрузите список слушателей — пункт закроется сам.',
					fact: 'teachers_group_formed',
					action: 'send_group'
				}),
				item('sessions_held', 'Занятия проведены', true, {
					help: 'Закроется по итогу из системы обучения или по отметке завершения потока преподавателей.',
					fact: 'teachers_training_completed',
					action: 'complete_group'
				}),
				item('feedback_collected', 'Собрана обратная связь', false, {
					help: 'Приложите или запишите комментарием обратную связь и отметьте.',
					action: 'upload'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('gaps_identified', 'Выявлены расхождения с требованиями', true, {
					help: 'Запишите расхождения с требованиями в результате стадии и отметьте.',
					action: 'result'
				}),
				item('changes_agreed', 'Изменения согласованы с учебным заведением', true, {
					help: 'Приложите протокол согласования изменений с вузом и отметьте.',
					action: 'upload'
				}),
				item('program_version_registered', 'Заведена новая версия программы', false, {
					help: 'Добавьте новую версию программы в справочнике «Программы» и закрепите её в составе дела — пункт закроется сам. Версия, выбранная раньше, его не закрывает.',
					fact: 'program_version_new'
				})
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
			requiresDocumentTemplate: null,
			// Занятия ведут со студентами: итог потока преподавателей по той же
			// программе — это обучение преподавателей, а не проведённые занятия.
			lmsGroupPurposes: ['students'],
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('schedule_published', 'Опубликовано расписание', true, {
					help: 'Приложите расписание или запишите комментарием ссылку на него и отметьте.',
					action: 'upload'
				}),
				item('attendance_tracked', 'Ведётся учёт посещаемости', true, {
					help: 'Отметьте, когда учёт посещаемости ведётся; журнал приложите файлом.',
					action: 'upload'
				}),
				item('midterm_review', 'Проведён промежуточный разбор', false, {
					help: 'Запишите итог промежуточного разбора в результате стадии и отметьте.',
					action: 'result'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('materials_revised', 'Обновлены учебные материалы', true, {
					help: 'Приложите обновлённые редакции материалов и отметьте.',
					action: 'upload'
				}),
				item('versions_published', 'Версии выложены в хранилище', true, {
					help: 'Запишите комментарием, в каком хранилище и по какой ссылке лежат версии, и отметьте.'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('course_selected', 'Подобрана программа повышения квалификации', true, {
					help: 'Заявите поток с назначением «Повышение квалификации» по программе дела — пункт закроется сам.',
					fact: 'upskilling_group_program',
					action: 'send_group'
				}),
				item('participants_enrolled', 'Участники зачислены', true, {
					help: 'Закроется, когда система обучения пришлёт зачисление по потоку повышения квалификации. Отправленный список — ещё не зачисление.',
					fact: 'upskilling_enrolled'
				}),
				item('certificates_issued', 'Выданы документы об обучении', false, {
					help: 'Приложите документы об обучении или реестр выдачи видом «Документ об обучении» — пункт закроется сам.',
					fact: 'training_document',
					action: 'upload'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			// Финальная стадия процесса: с неё взаимодействие завершают, а не идут
			// дальше, и перехода вперёд с неё не требуется.
			isFinal: true,
			checklist: [
				item('report_collected', 'Собран отчёт по мероприятию', true, {
					help: 'Приложите отчёт по мероприятию и отметьте.',
					action: 'upload'
				}),
				item('metrics_checked', 'Сверены плановые и фактические показатели', true, {
					help: 'Сверьте плановые и фактические показатели дела и отметьте; расхождения запишите комментарием.'
				}),
				item('next_period_planned', 'Намечен следующий период', false, {
					help: 'Запишите следующий период в результате стадии или создайте новое взаимодействие из карточки вуза, затем отметьте.',
					action: 'result'
				})
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
 * Коммерческое обучение — короткий процесс для физических и юридических лиц.
 *
 * Пять стадий вместо четырнадцати: у этого пространства нет ни своих экранов,
 * ни своих документов, а каждая стадия — это строка в сиде, колонка на доске и
 * случай в тестах. «Уточнение запроса» свёрнуто в приём заявки, «зачисление в поток» — в
 * обучение: оба были шагами без собственного доказательства исполнения.
 */
export const B2C_PROCESS: ProcessDefinitionInput = {
	name: 'Коммерческое обучение',
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('request_understood', 'Запрос понят и зафиксирован', true, {
					help: 'Запишите запрос заявителя комментарием в ленте и отметьте.'
				}),
				item('owner_assigned', 'Назначен ответственный', true, {
					help: 'Ответственный выбирается при заведении дела, у заявки с сайта — при приёме. Пункт закрыт, пока у дела есть ответственный; сменить его — «Передать другому сотруднику» в меню «Ещё».',
					fact: 'responsible_assigned'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('program_selected', 'Подобрана программа обучения', true, {
					help: 'Выберите программу в составе дела и отметьте.'
				}),
				item('offer_sent', 'Отправлены программа, стоимость и условия', true, {
					help: 'Отправьте программу, стоимость и условия, приложите отправленное и отметьте.',
					action: 'upload'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('contract_signed', 'Договор заключён', true, {
					help: 'Физическое лицо договор не подписывает: оплата по оферте — акцепт, и пункт закроется отметкой «Оплата получена». Юридическому лицу соберите договор в пакете документов, подписанный скан загрузите его новой редакцией (или видом «Договор») и отметьте «Утверждён».',
					fact: 'contract_concluded',
					action: 'mark'
				}),
				item('payment_received', 'Оплата получена', true, {
					help: 'Отметьте, когда оплата поступила. Оплата, загруженная с сайта, отмечает пункт сама.'
				})
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
			requiresDocumentTemplate: null,
			// Слушатели коммерческого обучения — работающие взрослые: их поток
			// заводится с назначением «Повышение квалификации».
			lmsGroupPurposes: ['upskilling'],
			onEnterNotify: null,
			isFinal: false,
			checklist: [
				item('enrolled', 'Слушатель зачислен в поток', true, {
					help: 'Заявите поток и отметьте, когда слушатель зачислен. Результат из системы обучения отмечает пункт сам.',
					action: 'send_group'
				}),
				item('classes_started', 'Занятия начаты', true, {
					help: 'Отметьте, когда занятия начались. Результат из системы обучения отмечает пункт сам.'
				})
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
			requiresDocumentTemplate: null,
			lmsGroupPurposes: null,
			onEnterNotify: null,
			isFinal: true,
			checklist: [
				item('assessment_done', 'Итоговая аттестация проведена', true, {
					help: 'Запишите итог аттестации результатом стадии — пункт закроется сам.',
					fact: 'stage_result',
					action: 'result'
				}),
				item('document_issued', 'Выдан документ об обучении', true, {
					help: 'Приложите документ об обучении видом «Документ об обучении» — пункт закроется сам.',
					fact: 'training_document',
					action: 'upload'
				}),
				item('feedback_collected', 'Собрана обратная связь', false, {
					help: 'Приложите или запишите комментарием обратную связь и отметьте.',
					action: 'upload'
				})
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
