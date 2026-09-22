-- Таблица соответствия «вид контрагента → место» остаётся только для приёма
-- заявок извне и получает честное имя.
--
-- Она существовала ради двух дел: выбрать процесс при создании взаимодействия и
-- направить заявку, пришедшую с сайта. Первое отпало само — взаимодействие
-- заводят внутри пространства, и место известно из адреса. Второе осталось: у
-- заявки нет человека, который выбрал бы, а адресат обязан быть однозначным.
--
-- Первичный ключ по виду контрагента **сохраняется**. Он и есть то самое
-- требование однозначности: два маршрута на один вид означали бы, что одна и та
-- же заявка попадает то в одно место, то в другое.
ALTER TABLE "process_group_counterparty_kinds" RENAME TO "workspace_intake_routes";--> statement-breakpoint
ALTER TABLE "workspace_intake_routes" RENAME COLUMN "group_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_intake_routes" RENAME CONSTRAINT "process_group_counterparty_kinds_pkey" TO "workspace_intake_routes_pkey";--> statement-breakpoint
ALTER TABLE "workspace_intake_routes" RENAME CONSTRAINT "process_group_counterparty_kinds_group_id_workspaces_id_fk" TO "workspace_intake_routes_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "process_group_counterparty_kinds_group_idx" RENAME TO "workspace_intake_routes_workspace_idx";
