GRANT SELECT ON public.boards            TO authenticated;
GRANT SELECT ON public.events            TO authenticated;
GRANT SELECT ON public.organizations     TO authenticated;
GRANT SELECT ON public.venues            TO authenticated;
GRANT SELECT ON public.talent            TO authenticated;
GRANT SELECT ON public.event_talent      TO authenticated;
GRANT SELECT ON public.board_flyers      TO authenticated;
GRANT INSERT ON public.board_submissions TO authenticated;
GRANT INSERT ON public.photos            TO authenticated;
GRANT INSERT ON public.event_reports     TO authenticated;

DO $$ BEGIN
  CREATE POLICY "authenticated insert" ON board_submissions FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "authenticated insert" ON photos FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "authenticated insert" ON event_reports FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;