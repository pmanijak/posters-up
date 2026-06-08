ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own record"
ON users FOR SELECT
USING (auth.uid() = id);
