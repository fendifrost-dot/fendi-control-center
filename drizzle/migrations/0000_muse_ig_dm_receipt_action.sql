ALTER TABLE public.muse_workboard_requests
  DROP CONSTRAINT IF EXISTS muse_workboard_requests_action_check;

ALTER TABLE public.muse_workboard_requests
  ADD CONSTRAINT muse_workboard_requests_action_check CHECK (action IN (
    'create_mission',
    'create_improvement',
    'create_task',
    'append_update',
    'record_measurement',
    'update_task_state',
    'update_task_verification',
    'update_improvement_state',
    'record_daily_report',
    'record_ig_dm_receipt'
  ));