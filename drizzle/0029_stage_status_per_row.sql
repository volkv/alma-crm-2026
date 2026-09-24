-- Срок стадии с учётом пауз — та же арифметика, что в 0001, по-другому
-- записанная.
--
-- В 0001 представление собрано из CTE, и на `entry` ссылаются дважды. Такое CTE
-- PostgreSQL материализует, и условие вызывающего («записи этого
-- взаимодействия», «открытая запись этой строки списка») внутрь не проходит:
-- любое обращение к представлению считало сроки всех записей стадий в базе и
-- только потом отбирало нужные. На нагрузочном наборе (24 тысячи записей) это
-- 40–60 мс на каждый запрос карточки и списка, а под полусотней пользователей —
-- база, занятая пересчётом одного и того же (`docs/performance.md`, замер
-- 2026-09-24).
--
-- Здесь каждая строка считается от своей записи: окно и норматив — боковым
-- подзапросом без таблиц, сумма пауз — агрегатом по паузам этой записи (индекс
-- `stage_pauses_entry_idx`). Условие по `stage_entries` теперь доходит до
-- индекса, а выборка всех записей (отчёт) стоит столько же, сколько раньше.
--
-- Столбцы, их порядок и типы — прежние, поэтому `CREATE OR REPLACE`. Агрегат
-- без `GROUP BY` возвращает строку и тогда, когда пауз нет: сумма пустая, и
-- `coalesce` даёт ноль, как `LEFT JOIN … GROUP BY` в прежней записи. Проверка
-- `p.id IS NOT NULL` прежней записи здесь не нужна: строки паузы без паузы
-- больше не бывает.
CREATE OR REPLACE VIEW stage_entry_status AS
SELECT
	se.id AS stage_entry_id,
	se.interaction_id,
	se.stage_id,
	se.entered_at,
	se.left_at,
	w.window_end,
	w.sla_days,
	p.paused_seconds,
	(extract(epoch FROM (w.window_end - se.entered_at)) - p.paused_seconds)::double precision
		AS active_seconds,
	d.due_at,
	(se.left_at IS NULL AND p.has_open_pause) AS is_paused,
	extract(epoch FROM (d.due_at - w.window_end))::double precision AS remaining_seconds,
	greatest(0, -extract(epoch FROM (d.due_at - w.window_end)))::double precision
		AS overdue_seconds,
	(d.due_at < w.window_end) AS is_overdue
FROM stage_entries se
CROSS JOIN LATERAL (
	SELECT
		coalesce(se.left_at, now()) AS window_end,
		(se.stage_snapshot ->> 'slaDays')::integer AS sla_days
) w
CROSS JOIN LATERAL (
	SELECT
		coalesce(
			sum(
				extract(epoch FROM (
					least(coalesce(pause.ended_at, w.window_end), w.window_end)
					- greatest(pause.started_at, se.entered_at)
				))
			) FILTER (
				WHERE least(coalesce(pause.ended_at, w.window_end), w.window_end)
					> greatest(pause.started_at, se.entered_at)
			),
			0
		)::double precision AS paused_seconds,
		coalesce(bool_or(pause.ended_at IS NULL), false) AS has_open_pause
	FROM stage_pauses pause
	WHERE pause.stage_entry_id = se.id
) p
CROSS JOIN LATERAL (
	SELECT
		se.entered_at
			+ make_interval(days => w.sla_days)
			+ make_interval(secs => p.paused_seconds) AS due_at
) d;
