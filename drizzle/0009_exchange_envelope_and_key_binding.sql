-- Конверт исходящего сообщения и привязка ключа к подключению обмена.
--
-- `exchange_messages.envelope` хранит то, что действительно ушло получателю, —
-- строкой, а не `jsonb`: повтор обязан уйти байт в байт, а `jsonb` хранит
-- разобранное значение и порядка полей не сохраняет. Раньше тело собиралось
-- заново на каждой попытке и затирало `payload`: после первой неудачи семя
-- заявки пропадало и повтор отправлять было уже нечего, а у дошедших попыток
-- менялся `occurredAt` — повтор нёс другое сообщение под тем же `event_id`.
-- Столбец пуст у входящих и у исходящих, которые ещё ни разу не уходили;
-- заполняется один раз, перед первой отправкой.
--
-- `api_keys.exchange_system` и `exchange_instance` называют подключение, от
-- имени которого работает ключ. Права роли `service` одинаковы у всех ключей
-- обмена, поэтому без этой пары ключ сайта подавал бы результаты учебных
-- групп, а ключ системы обучения — заявки. У выпущенных раньше ключей пары
-- нет: маршруты обмена им закрываются, и такой ключ отзывают и выпускают
-- заново — это единственный способ сказать, чей он.
ALTER TABLE "api_keys" ADD COLUMN "exchange_system" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "exchange_instance" text;--> statement-breakpoint
ALTER TABLE "exchange_messages" ADD COLUMN "envelope" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_exchange_link_consistent" CHECK (("api_keys"."exchange_system" is null) = ("api_keys"."exchange_instance" is null));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_exchange_system_known" CHECK ("api_keys"."exchange_system" is null or "api_keys"."exchange_system" in ('cms', 'lms'));