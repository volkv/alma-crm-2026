-- Вход переезжает во внешний каталог учётных записей.
--
-- Уходят столбцы, которыми человек доказывал, что он это он: хеш пароля, дата
-- его смены, секрет второго фактора и резервные коды. Доказывает теперь
-- каталог, а приложение получает от него проверенный токен (`docs/auth.md`);
-- хранить рядом второй способ войти значило бы оставить обход каталога.
--
-- Данные этих столбцов не переносятся никуда и восстановлению не подлежат: у
-- пароля и секрета второго фактора нет и не может быть представления во
-- внешнем каталоге. Учётные записи остаются на месте — их связывает с каталогом
-- `external_subject`, который проставляется при первом входе по подтверждённой
-- почте.
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_changed_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_secret";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_enabled_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_backup_codes";--> statement-breakpoint

-- Роль «Наблюдатель» уходит: «только смотреть» не отвечает ни одному живому
-- сценарию (`docs/access-matrix.md`, раздел 1).
--
-- Порядок обязателен. `users.role_id` ссылается на `roles` с `on delete
-- restrict`, поэтому сначала записи переводятся на `manager` — роль с самым
-- узким набором прав, — и только потом роль исчезает. Сделать это обязана
-- миграция, а не сид ролей: `seedRolesAndPermissions` удаляет роли, которых нет
-- в коде, и на непереведённой записи он упёрся бы во внешний ключ.
--
-- `where exists` — на случай установки, где роли `viewer` не было вовсе:
-- миграция обязана пройти и на ней.
UPDATE "users" SET "role_id" = 'manager', "updated_at" = now()
WHERE "role_id" = 'viewer'
  AND EXISTS (SELECT 1 FROM "roles" WHERE "id" = 'manager');--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "role_id" = 'viewer';--> statement-breakpoint
DELETE FROM "roles" WHERE "id" = 'viewer';
