-- Add storage_object_path, tax_year, source to documents if missing
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='storage_object_path') THEN
    ALTER TABLE public.documents ADD COLUMN storage_object_path text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='tax_year') THEN
    ALTER TABLE public.documents ADD COLUMN tax_year integer;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='source') THEN
    ALTER TABLE public.documents ADD COLUMN source text DEFAULT 'drive';
  END IF;
END $$;

-- Make drive_file_id nullable so upload rows can set it to null
ALTER TABLE public.documents ALTER COLUMN drive_file_id DROP NOT NULL;