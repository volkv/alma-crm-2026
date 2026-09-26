-- Уровень образования у учебного заведения становится необязательным.
--
-- Вуз заводят и из ЕГРЮЛ прямо в форме взаимодействия, а в реестре уровня нет:
-- его угадывают по ОКВЭД и названию, и не угаданный уровень остаётся пустым до
-- правки карточки. Запрет уровня у остальных видов сохраняется.
--
-- Существующие строки новому правилу удовлетворяют: прежнее было строже.
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_education_level_matches_kind";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_education_level_matches_kind" CHECK ("organizations"."education_level" is null or "organizations"."kind" = 'educational_institution');