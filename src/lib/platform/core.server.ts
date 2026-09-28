/**
 * Фасад сервисов ядра для серверной части модулей.
 *
 * Модулю запрещено импортировать `$lib/server/**` напрямую: всё, чем он может
 * пользоваться на сервере, перечислено здесь. Список закрытый и полный заранее —
 * права, журнал, обмен с LMS и справочник остаются сервисами ядра, модуль их
 * только зовёт. Новый экспорт сюда — решение о границе, а не удобство.
 */

// Контекст действующего лица и ошибки.
export { actorFromEvent, type ActorContext } from '$lib/server/actor';
export { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '$lib/server/errors';
export { toActionFailure, toPageError } from '$lib/server/http';
export { DocumentConversionError } from '$lib/server/documents/errors';

// База, права, журнал.
export { getDb } from '$lib/server/db';
export { withTransaction, type Tx } from '$lib/server/db/transaction';
export { can, requirePermission } from '$lib/server/rbac';
export { recordAuditEvent } from '$lib/server/audit';
export { assertInteractionVisible, interactionScopeFilter } from '$lib/server/interactions/access';

// Таблицы, которые модули читают.
export {
	contractItems,
	documentContractItems,
	documents,
	interactionTerms,
	interactions,
	learningGroupLearners,
	learningGroupResults,
	learningGroups,
	people,
	programs,
	users,
	workflows,
	workspaces
} from '$lib/server/db/schema';

// Формы и дело.
export { fields, fileField, parse, run, text } from '$lib/server/forms';
export { getInteraction } from '$lib/server/interactions/read';
export { updateInteraction } from '$lib/server/interactions/write';

// Обмен с системой обучения.
export {
	listLearningGroups,
	markLearningGroupCompleted,
	requestLearningGroup
} from '$lib/server/integrations/exchange/groups';
export {
	addCounterpartyLearner,
	exportLearningGroupRoster,
	importLearningGroupRoster,
	listInteractionLearners,
	previewLearningGroupRoster,
	removeLearner,
	sendLearningGroupRoster
} from '$lib/server/integrations/exchange/roster';

// Справочник и люди.
export { contactFullName } from '$lib/server/directory/contacts';
export { listAffiliations } from '$lib/server/directory/read';
export { listOrganizationContracts } from '$lib/server/directory/contracts';
export { withPiiTrace } from '$lib/server/people/pii-trace';
export { toPersonView } from '$lib/server/people/serialize';

// Кому из контактов стороны и коллег можно написать по делу.
export {
	contactGreetingName,
	contactPersonName,
	contactUnavailableReason,
	readCaseContacts,
	resolveCaseContacts
} from '$lib/server/interactions/contact-addressees';
export { canUserSeeInteraction, listInteractionViewers } from '$lib/server/live/viewers';

// Письма людям вне системы: песочница, отправка и шаблон приглашения на встречу.
export { outboundMailPolicy, sendOutboundMail } from '$lib/server/mail/outbound';
export { meetingInviteEmail, type MeetingMailKind } from '$lib/server/mail/meeting-invite';
// Письма вузу уходят в фоне: модуль ставит задание в своей транзакции, а
// обработчик вида (`mail` в `defineCardServer`) шлёт письма после фиксации.
export {
	enqueueOutboundMail,
	payloadIds,
	readOutboundMailInFlight,
	singleMailResult,
	type OutboundMailHandler,
	type OutboundMailJob,
	type OutboundMailResult
} from '$lib/server/mail/queue';

// Файлы.
export { contentDisposition } from '$lib/server/documents/filename';

// Модули пространства и их факты в истории дела.
export { assertModuleActive, readActiveModules } from '$lib/server/platform/workspace-modules';
export {
	readModuleFact,
	recordModuleFact,
	recordModuleFactIn
} from '$lib/server/platform/module-facts';
