CREATE POLICY "tax-documents authenticated select"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'tax-documents');