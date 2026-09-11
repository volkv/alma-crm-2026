-- Журнал действий: только добавление.
--
-- Право на UPDATE и DELETE можно отобрать грантами, но грант живёт в базе, а не
-- в репозитории, и переживает не всякое восстановление из дампа. Триггер едет
-- вместе со схемой, поэтому запись журнала нельзя ни исправить, ни удалить на
-- любой установке. TRUNCATE строковыми триггерами не перехватывается: он
-- требует прав владельца таблицы, которых у роли приложения нет, а тестам он
-- нужен для очистки между проверками.
CREATE FUNCTION audit_events_append_only() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: % is not allowed', tg_op
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
	BEFORE UPDATE OR DELETE ON audit_events
	FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
-- Срок стадии с учётом пауз.
--
-- Окно записи — от входа на стадию до `left_at`, а у ещё открытой записи до
-- `now()`. Пауза вычитается ровно на длину своего пересечения с этим окном:
-- ждать ответа вуза и не успеть — разные вещи, и отчёт обязан их различать.
-- Поэтому `due_at` сдвигается на `paused_seconds`, а не просто «часы стоят».
--
-- Закрытая запись перестаёт «ехать»: её окно больше не растёт, и просрочка
-- остаётся такой, какой была в момент выхода со стадии.
--
-- Норматив берётся из слепка стадии, а не из таблицы `stages`: маршрут могли
-- переиздать, а срок уже пройденной стадии обязан остаться прежним.
CREATE VIEW stage_entry_status AS
WITH entry AS (
	SELECT
		se.id AS stage_entry_id,
		se.interaction_id,
		se.stage_id,
		se.entered_at,
		se.left_at,
		coalesce(se.left_at, now()) AS window_end,
		(se.stage_snapshot ->> 'slaDays')::integer AS sla_days
	FROM stage_entries se
), paused AS (
	SELECT
		e.stage_entry_id,
		-- `p.id IS NOT NULL` обязателен: LEFT JOIN без совпадений даёт строку, где
		-- все столбцы паузы пусты, а `greatest`/`least` в PostgreSQL пропускают
		-- NULL — без этой проверки запись без пауз выглядела бы как пауза во всё
		-- окно.
		coalesce(
			sum(
				extract(epoch FROM (
					least(coalesce(p.ended_at, e.window_end), e.window_end)
					- greatest(p.started_at, e.entered_at)
				))
			) FILTER (
				WHERE p.id IS NOT NULL
					AND least(coalesce(p.ended_at, e.window_end), e.window_end)
						> greatest(p.started_at, e.entered_at)
			),
			0
		)::double precision AS paused_seconds,
		coalesce(bool_or(p.id IS NOT NULL AND p.ended_at IS NULL), false) AS has_open_pause
	FROM entry e
	LEFT JOIN stage_pauses p ON p.stage_entry_id = e.stage_entry_id
	GROUP BY e.stage_entry_id
), computed AS (
	SELECT
		e.stage_entry_id,
		e.interaction_id,
		e.stage_id,
		e.entered_at,
		e.left_at,
		e.window_end,
		e.sla_days,
		p.paused_seconds,
		p.has_open_pause,
		e.entered_at
			+ make_interval(days => e.sla_days)
			+ make_interval(secs => p.paused_seconds) AS due_at
	FROM entry e
	JOIN paused p ON p.stage_entry_id = e.stage_entry_id
)
SELECT
	c.stage_entry_id,
	c.interaction_id,
	c.stage_id,
	c.entered_at,
	c.left_at,
	c.window_end,
	c.sla_days,
	c.paused_seconds,
	(extract(epoch FROM (c.window_end - c.entered_at)) - c.paused_seconds)::double precision
		AS active_seconds,
	c.due_at,
	(c.left_at IS NULL AND c.has_open_pause) AS is_paused,
	extract(epoch FROM (c.due_at - c.window_end))::double precision AS remaining_seconds,
	greatest(0, -extract(epoch FROM (c.due_at - c.window_end)))::double precision
		AS overdue_seconds,
	(c.due_at < c.window_end) AS is_overdue
FROM computed c;
