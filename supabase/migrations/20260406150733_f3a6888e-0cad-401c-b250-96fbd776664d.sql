UPDATE auth.users 
SET encrypted_password = crypt('TaxPrep2026!', gen_salt('bf'))
WHERE email = 'fendifrost@gmail.com' AND id = 'e687bfde-7afc-4538-ae05-587592516ec7';