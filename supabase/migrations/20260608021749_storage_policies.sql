-- Allow authenticated users to upload to photos-raw
CREATE POLICY "Authenticated users can upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'photos-raw');

-- Allow authenticated users to read from photos-raw
CREATE POLICY "Authenticated users can read"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'photos-raw');
