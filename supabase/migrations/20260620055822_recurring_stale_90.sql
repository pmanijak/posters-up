UPDATE config
SET value = '90', updated_at = now()
WHERE key = 'recurring_event_staleness_days';