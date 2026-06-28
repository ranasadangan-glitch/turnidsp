-- ============================================================
-- Seed data for TurniDSP Platform
-- Default admin password is 'admin123' (bcrypt hash below) — CHANGE IT.
-- Run after 01_schema.sql
-- ============================================================

-- Branches (5-7)
INSERT INTO branches (code, name, address) VALUES
  ('DLO1','DLO1 — Milano','Via Salomone 1, Milano'),
  ('DLO7','DLO7 — Milano',NULL),
  ('DLO2','DLO2',NULL),
  ('DLO3','DLO3',NULL),
  ('DLO4','DLO4',NULL)
ON CONFLICT (code) DO NOTHING;

-- Parking points (example for DLO1)
INSERT INTO parking_points (branch_id, name, address, meet_time)
  SELECT id, 'Parcheggio Via Salomone 1', 'Via Salomone 1, Milano', '09:00' FROM branches WHERE code='DLO1'
ON CONFLICT DO NOTHING;

-- Service types
INSERT INTO service_types (code, name, default_shift_code, meet_time, color, sort_order) VALUES
  ('NEXT','NEXT DAY','X','09:00','#B97E10',1),
  ('SAMEA','Same A','SameA','11:30','#1F5FBF',2),
  ('SAMEB','Same B','SameB','13:00','#7A3FB8',3),
  ('SAMEC','Same C','SameC','14:00','#0E7E74',4),
  ('SAMEE','Same E','SameE','15:00','#2E9E5B',5),
  ('CARGO','Cargo','Cargo','08:00','#475066',6),
  ('RESCUE','Rescue','Rescue','12:00','#C77700',7),
  ('EXTRA','Extra','Extra',NULL,'#6FA8FF',8)
ON CONFLICT (code) DO NOTHING;

-- Shift / absence codes (legenda)
INSERT INTO shift_codes (code,label,category,is_work,is_absence,is_off) VALUES
  ('X','NEXT','next',TRUE,FALSE,FALSE),
  ('SameA','Same A','samea',TRUE,FALSE,FALSE),
  ('SameAE','Same A/E','samea',TRUE,FALSE,FALSE),
  ('SameB','Same B','sameb',TRUE,FALSE,FALSE),
  ('SameC','Same C','sameb',TRUE,FALSE,FALSE),
  ('SameE','Same E','samea',TRUE,FALSE,FALSE),
  ('Cargo','Cargo','next',TRUE,FALSE,FALSE),
  ('Rescue','Rescue','mm',TRUE,FALSE,FALSE),
  ('Extra','Extra','next',TRUE,FALSE,FALSE),
  ('UFFICIO','Ufficio','abs',TRUE,FALSE,FALSE),
  ('OFF','Riposo','off',FALSE,FALSE,TRUE),
  ('F','Ferie','mal',FALSE,TRUE,FALSE),
  ('M','Malattia','mal',FALSE,TRUE,FALSE),
  ('I','Infortunio','mal',FALSE,TRUE,FALSE),
  ('PR','Permesso','mal',FALSE,TRUE,FALSE)
ON CONFLICT (code) DO NOTHING;

-- Contract types
INSERT INTO contract_types (code,label,weekly_hours,default_days) VALUES
  ('21','Full-time 40h',40,5),
  ('13','Part-time 30h',30,5),
  ('20','Part-time 20h',20,4)
ON CONFLICT (code) DO NOTHING;

-- Admin user (password: admin123 — bcrypt, cost 10). CHANGE IMMEDIATELY.
INSERT INTO users (username,password_hash,full_name,role)
VALUES ('admin','$2a$10$93mNMBZBFxDXeyGm6wb0iO5z.cv202M.KJ8a0/ieaMLtsxNH2.30.','Amministratore','admin')
ON CONFLICT (username) DO NOTHING;

-- Example team + leader
INSERT INTO teams (branch_id,name)
  SELECT id,'Team Milano A' FROM branches WHERE code='DLO1'
ON CONFLICT DO NOTHING;
