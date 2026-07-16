-- Migration: 006_alter_business_type.sql
-- Remove CHECK constraint on businesses.type to allow dynamic types

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_type_check;
